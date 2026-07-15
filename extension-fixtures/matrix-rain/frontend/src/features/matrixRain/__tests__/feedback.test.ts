import { describe, expect, it } from "vitest";
import {
  advectionSourceRow,
  clamp01,
  fallCells,
  luma,
  rainBodyBrightness,
  retention,
  softAdd,
  updateRainState,
  type FeedbackParameters,
} from "../utils/matrixRainMath";
import {
  calculateStateGridSize,
  stateNeedsReallocation,
  stateTopologyChanged,
} from "../utils/feedbackLifecycle";

const PARAMS: FeedbackParameters = {
  trailHalfLife: 0.45,
  baseInjection: 0.04,
  sourceInfluence: 0.85,
};

describe("retention", () => {
  it("retains exactly half over one half-life, regardless of frame rate", () => {
    expect(retention(0.45, 0.45)).toBeCloseTo(0.5, 6);
    // Same elapsed time reached in two 30fps steps vs one 15fps step decays the
    // same amount (frame-rate independence).
    const oneStep = retention(1 / 15, 0.45);
    const twoSteps = retention(1 / 30, 0.45) * retention(1 / 30, 0.45);
    expect(twoSteps).toBeCloseTo(oneStep, 6);
  });

  it("does not decay across a zero-delta sample", () => {
    expect(retention(0, 0.45)).toBe(1);
  });
});

describe("softAdd", () => {
  it("is a saturating union bounded by 1", () => {
    expect(softAdd(0, 0)).toBe(0);
    expect(softAdd(1, 0.5)).toBe(1);
    expect(softAdd(0.5, 0.5)).toBeCloseTo(0.75, 6);
    expect(softAdd(2, 2)).toBe(1); // clamps inputs
  });
});

describe("luma", () => {
  it("uses Rec.709 weights", () => {
    expect(luma(1, 1, 1)).toBeCloseTo(1, 6);
    expect(luma(0, 1, 0)).toBeCloseTo(0.7152, 6);
    expect(luma(0, 0, 0)).toBe(0);
  });
});

describe("advection", () => {
  it("reads rain from fallCells above (rain descends)", () => {
    expect(advectionSourceRow(10, 2)).toBe(8);
    expect(fallCells(8, 0.5)).toBe(4);
    expect(fallCells(8, 0)).toBe(0);
  });
});

describe("updateRainState", () => {
  const base = {
    advectedRain: 0,
    currentSignal: 0,
    proceduralTrail: 1,
    proceduralHead: 0,
    deltaSeconds: 1 / 30,
    params: PARAMS,
  };

  it("makes a newly visible feature legible immediately via the B channel", () => {
    // Cold state (advectedRain 0) with a bright source: the direct-shape term is
    // available on the same frame through B, before rain history develops.
    const next = updateRainState({ ...base, advectedRain: 0, currentSignal: 0.9 });
    expect(next.b).toBeCloseTo(0.9, 6);
    expect(rainBodyBrightness(next, 1, 0.25)).toBeGreaterThan(0);
  });

  it("keeps a static source structure legible in B every frame", () => {
    const a = updateRainState({ ...base, currentSignal: 0.6 });
    const b = updateRainState({ ...base, advectedRain: a.r, currentSignal: 0.6 });
    expect(a.b).toBeCloseTo(0.6, 6);
    expect(b.b).toBeCloseTo(0.6, 6);
  });

  it("descends and fades earlier illumination when injection stops", () => {
    // Seed some rain, then advect/decay with no new injection.
    let r = 0.8;
    const prev = r;
    for (let i = 0; i < 3; i += 1) {
      const next = updateRainState({
        ...base,
        advectedRain: r,
        currentSignal: 0,
        proceduralTrail: 0,
        params: { ...PARAMS, baseInjection: 0 },
      });
      r = next.r;
    }
    expect(r).toBeLessThan(prev);
    expect(r).toBeGreaterThan(0);
  });

  it("does not accumulate on a zero-delta sample", () => {
    const seeded = updateRainState({ ...base, advectedRain: 0.5, currentSignal: 0.9 });
    // Re-run at the same time (dt = 0): retention is 1 and injection is gated
    // off, so R is unchanged — no runaway accumulation while paused.
    const repeated = updateRainState({
      ...base,
      advectedRain: seeded.r,
      currentSignal: 0.9,
      deltaSeconds: 0,
    });
    expect(repeated.r).toBeCloseTo(seeded.r, 6);
  });

  it("gates static injection by the procedural trail so a silhouette never saturates", () => {
    // With the procedural trail at 0, only the tiny base injection is added, so a
    // static bright region cannot fill to 1 no matter how strong the source.
    let r = 0;
    for (let i = 0; i < 200; i += 1) {
      r = updateRainState({
        ...base,
        advectedRain: r,
        currentSignal: 1,
        proceduralTrail: 0,
        params: { ...PARAMS, baseInjection: 0 },
      }).r;
    }
    expect(r).toBe(0);
  });
});

describe("feedback lifecycle", () => {
  it("calculates one state texel per glyph cell", () => {
    expect(calculateStateGridSize(1920, 1080, 10, 2)).toEqual({
      width: 192,
      height: 90,
    });
    expect(calculateStateGridSize(101, 101, 10, 2)).toEqual({
      width: 11,
      height: 9,
    });
  });

  it("reallocates only when grid dimensions change", () => {
    expect(stateNeedsReallocation(null, 100, 100)).toBe(true);
    expect(stateNeedsReallocation({ width: 100, height: 100 }, 100, 100)).toBe(false);
    expect(stateNeedsReallocation({ width: 100, height: 100 }, 200, 100)).toBe(true);
    expect(stateNeedsReallocation(null, 0, 100)).toBe(false);
  });

  it("resets on size, spacing, or dimension changes but not uniform edits", () => {
    const topo = { width: 100, height: 100, size: 10, verticalSpacing: 2 };
    expect(stateTopologyChanged(null, topo)).toBe(true);
    expect(stateTopologyChanged(topo, { ...topo })).toBe(false);
    expect(stateTopologyChanged(topo, { ...topo, size: 12 })).toBe(true);
    expect(stateTopologyChanged(topo, { ...topo, verticalSpacing: 3 })).toBe(true);
    expect(stateTopologyChanged(topo, { ...topo, width: 128 })).toBe(true);
  });
});

describe("clamp01", () => {
  it("clamps into the unit range", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
  });
});
