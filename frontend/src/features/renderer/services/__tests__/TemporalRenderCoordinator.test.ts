import { describe, expect, it } from "vitest";
import { TICKS_PER_SECOND } from "../../../timeline";
import {
  TemporalRenderBranch,
  TemporalRenderCoordinator,
} from "../TemporalRenderCoordinator";
import type { TemporalRenderingRequirements } from "../../../transformations/catalogue/temporalRenderingRequirements";

const HISTORY: TemporalRenderingRequirements = {
  timeDependency: "history",
  maxHistorySeconds: 2,
  maxStepSeconds: 1 / 30,
};

describe("TemporalRenderCoordinator", () => {
  it("plans bounded warm-up samples before a random-access target", () => {
    const coordinator = new TemporalRenderCoordinator();
    const targetTick = 10 * TICKS_PER_SECOND;
    const plan = coordinator.plan({
      presentationTick: targetTick,
      fps: 30,
      mode: "export",
      requirements: HISTORY,
    });

    expect(plan.isDiscontinuous).toBe(true);
    expect(plan.warmup).toHaveLength(60);
    expect(plan.warmup[0]).toMatchObject({
      presentationTimeTicks: 8 * TICKS_PER_SECOND,
      continuity: "discontinuous",
      isWarmup: true,
    });
    expect(plan.warmup.at(-1)?.presentationTimeTicks).toBe(
      targetTick - TICKS_PER_SECOND / 30,
    );
    expect(plan.target).toMatchObject({
      presentationTimeTicks: targetTick,
      continuity: "sequential",
      isWarmup: false,
    });
    expect(
      plan.warmup.every(
        (sample) => sample.sequenceId === plan.target.sequenceId,
      ),
    ).toBe(true);
  });

  it("reuses sample identity for a paused repeat and advances sequentially", () => {
    const coordinator = new TemporalRenderCoordinator();
    const first = coordinator.plan({
      presentationTick: 0,
      fps: 30,
      mode: "preview",
      requirements: HISTORY,
    });
    const repeat = coordinator.plan({
      presentationTick: 0,
      fps: 30,
      mode: "preview",
      requirements: HISTORY,
    });
    const next = coordinator.plan({
      presentationTick: TICKS_PER_SECOND / 30,
      fps: 30,
      mode: "preview",
      requirements: HISTORY,
    });

    expect(repeat.target.sampleId).toBe(first.target.sampleId);
    expect(repeat.target.continuity).toBe("repeat");
    expect(next.target.sequenceId).toBe(first.target.sequenceId);
    expect(next.target.continuity).toBe("sequential");
    expect(next.target.deltaTimeTicks).toBe(TICKS_PER_SECOND / 30);
  });

  it("starts a new sequence and never replays future samples after a backward seek", () => {
    const coordinator = new TemporalRenderCoordinator();
    const later = coordinator.plan({
      presentationTick: 5 * TICKS_PER_SECOND,
      fps: 30,
      mode: "preview",
      requirements: HISTORY,
    });
    const earlier = coordinator.plan({
      presentationTick: 3 * TICKS_PER_SECOND,
      fps: 30,
      mode: "preview",
      requirements: HISTORY,
    });

    expect(earlier.target.sequenceId).not.toBe(later.target.sequenceId);
    expect(earlier.warmup.length).toBeGreaterThan(0);
    expect(
      earlier.warmup.every(
        (sample) =>
          sample.presentationTimeTicks < earlier.target.presentationTimeTicks,
      ),
    ).toBe(true);
  });

  it("bridges dropped frames but invalidates a forward jump beyond history", () => {
    const coordinator = new TemporalRenderCoordinator();
    const first = coordinator.plan({
      presentationTick: 0,
      fps: 30,
      mode: "preview",
      requirements: HISTORY,
    });
    const next = coordinator.plan({
      presentationTick: TICKS_PER_SECOND / 30,
      fps: 30,
      mode: "preview",
      requirements: HISTORY,
    });
    const dropped = coordinator.plan({
      presentationTick: (3 * TICKS_PER_SECOND) / 30,
      fps: 30,
      mode: "preview",
      requirements: HISTORY,
    });
    const jump = coordinator.plan({
      presentationTick: 5 * TICKS_PER_SECOND,
      fps: 30,
      mode: "preview",
      requirements: HISTORY,
    });

    expect(next.target.sequenceId).toBe(first.target.sequenceId);
    expect(dropped.target.sequenceId).toBe(next.target.sequenceId);
    expect(dropped.warmup).toHaveLength(1);
    expect(dropped.warmup[0]?.presentationTimeTicks).toBe(
      (2 * TICKS_PER_SECOND) / 30,
    );
    expect(jump.target.sequenceId).not.toBe(dropped.target.sequenceId);
    expect(jump.warmup.length).toBeGreaterThan(0);
  });

  it("produces the same bounded random-access schedule in independent runs", () => {
    const request = {
      presentationTick: 10 * TICKS_PER_SECOND,
      fps: 30,
      mode: "export" as const,
      requirements: HISTORY,
      earliestTick: 8 * TICKS_PER_SECOND,
    };

    const first = new TemporalRenderCoordinator().plan(request);
    const second = new TemporalRenderCoordinator().plan(request);

    expect(second).toEqual(first);
    expect([
      ...first.warmup.map((sample) => sample.presentationTimeTicks),
      first.target.presentationTimeTicks,
    ]).toEqual(
      Array.from(
        { length: 61 },
        (_, index) =>
          8 * TICKS_PER_SECOND + index * (TICKS_PER_SECOND / 30),
      ),
    );
  });

  it("clamps replay to the declared earliest available tick", () => {
    const coordinator = new TemporalRenderCoordinator();
    const plan = coordinator.plan({
      presentationTick: 5 * TICKS_PER_SECOND,
      fps: 30,
      mode: "still",
      requirements: HISTORY,
      earliestTick: 4 * TICKS_PER_SECOND,
    });

    expect(plan.warmup[0]?.presentationTimeTicks).toBe(4 * TICKS_PER_SECOND);
    expect(
      plan.warmup.every(
        (sample) => sample.presentationTimeTicks >= 4 * TICKS_PER_SECOND,
      ),
    ).toBe(true);
  });

  it("replays when temporal topology changes at a paused sample", () => {
    const coordinator = new TemporalRenderCoordinator();
    const first = coordinator.plan({
      presentationTick: 5 * TICKS_PER_SECOND,
      fps: 30,
      mode: "preview",
      requirements: HISTORY,
      topologyKey: "history-a",
    });
    const changed = coordinator.plan({
      presentationTick: 5 * TICKS_PER_SECOND,
      fps: 30,
      mode: "preview",
      requirements: HISTORY,
      topologyKey: "history-a|history-b",
    });

    expect(changed.target.sequenceId).not.toBe(first.target.sequenceId);
    expect(changed.warmup).toHaveLength(60);
    expect(changed.target.continuity).toBe("sequential");
  });

  it("bridges an ordinary output step that exceeds a filter's maximum step", () => {
    const coordinator = new TemporalRenderCoordinator();
    const first = coordinator.plan({
      presentationTick: 0,
      fps: 24,
      mode: "export",
      requirements: HISTORY,
    });
    const next = coordinator.plan({
      presentationTick: TICKS_PER_SECOND / 24,
      fps: 24,
      mode: "export",
      requirements: HISTORY,
    });

    expect(next.isDiscontinuous).toBe(false);
    expect(next.target.sequenceId).toBe(first.target.sequenceId);
    expect(next.warmup).toHaveLength(1);
    expect(next.warmup[0]).toMatchObject({
      presentationTimeTicks: TICKS_PER_SECOND / 30,
      continuity: "sequential",
      isWarmup: true,
    });
    expect(next.target.deltaTimeTicks).toBe(
      TICKS_PER_SECOND / 24 - TICKS_PER_SECOND / 30,
    );
  });
});

describe("TemporalRenderBranch", () => {
  it("invalidates temporal state when a conditional branch reactivates", () => {
    const coordinator = new TemporalRenderCoordinator();
    const branch = new TemporalRenderBranch();
    const first = coordinator.plan({
      presentationTick: 0,
      fps: 30,
      mode: "preview",
      requirements: HISTORY,
    }).target;
    const next = coordinator.plan({
      presentationTick: TICKS_PER_SECOND / 30,
      fps: 30,
      mode: "preview",
      requirements: HISTORY,
    }).target;

    const unavailable = branch.map(first, "unavailable:mask-a");
    const available = branch.map(next, "masked:mask-a");
    const repeatedBranch = branch.map(next, "masked:mask-a");

    expect(unavailable.continuity).toBe("discontinuous");
    expect(available.continuity).toBe("discontinuous");
    expect(available.sequenceId).not.toBe(unavailable.sequenceId);
    expect(repeatedBranch.sequenceId).toBe(available.sequenceId);
    expect(repeatedBranch.continuity).toBe(next.continuity);

    branch.reset();
    expect(branch.map(next, "masked:mask-a").continuity).toBe(
      "discontinuous",
    );
  });
});
