import { describe, it, expect, vi } from "vitest";
import { Texture } from "pixi.js";
import {
  RenderFramePlanner,
  countDedupedDecodes,
  planFrameDecodes,
  type FrameTextureOps,
  type PlannedClipJob,
} from "../RenderFramePlanner";
import { SourceFrameDecodeScheduler } from "../SourceFrameDecodeScheduler";
import { SharedTextureStore } from "../SharedTextureStore";
import type {
  SourceFrameSyncIntent,
  SourceFrameSyncRef,
} from "../../utils/sourceFrameSync";
import type { TimelineClip } from "../../../../types/TimelineTypes";

/**
 * Phase 4 planning kernel: group a tick's resolved clip jobs by the decoded
 * source frame they share. Pure — no decode, no GPU. Jobs carry only the fields
 * the planner reads (decodeKey); the rest is preserved opaquely.
 */

function job(trackId: string, decodeKey: string | null): PlannedClipJob {
  return {
    trackId,
    activeClip: { id: `clip-${trackId}` } as TimelineClip,
    sourceFrame: {
      decodeKey,
      key: `${trackId}:${decodeKey}`,
      generation: 0,
    } as SourceFrameSyncRef,
    maskClips: [],
  };
}

describe("planFrameDecodes", () => {
  it("groups duplicate clips at the same decodeKey into one shared decode", () => {
    const a = job("t1", "asset-1:2:30:0.066");
    const b = job("t2", "asset-1:2:30:0.066");

    const plan = planFrameDecodes([a, b]);

    expect(plan.decodeGroups).toHaveLength(1);
    expect(plan.decodeGroups[0].decodeKey).toBe("asset-1:2:30:0.066");
    expect(plan.decodeGroups[0].jobs).toEqual([a, b]);
    expect(countDedupedDecodes(plan)).toBe(1);
  });

  it("keeps distinct decodeKeys as separate groups in first-seen order", () => {
    const a = job("t1", "asset-1:2:30:0.066");
    const b = job("t2", "asset-2:2:30:0.066");

    const plan = planFrameDecodes([a, b]);

    expect(plan.decodeGroups.map((g) => g.decodeKey)).toEqual([
      "asset-1:2:30:0.066",
      "asset-2:2:30:0.066",
    ]);
    expect(countDedupedDecodes(plan)).toBe(0);
  });

  it("excludes null-decodeKey (text/brush) jobs from groups but keeps them in jobs", () => {
    const asset = job("t1", "asset-1:2:30:0.066");
    const text = job("t2", null);

    const plan = planFrameDecodes([asset, text]);

    expect(plan.jobs).toEqual([asset, text]);
    expect(plan.decodeGroups).toHaveLength(1);
    expect(plan.decodeGroups[0].jobs).toEqual([asset]);
  });

  it("treats a single asset job as a group of one (one decode, no sharing)", () => {
    const a = job("t1", "asset-1:2:30:0.066");

    const plan = planFrameDecodes([a]);

    expect(plan.decodeGroups).toHaveLength(1);
    expect(plan.decodeGroups[0].jobs).toEqual([a]);
    expect(countDedupedDecodes(plan)).toBe(0);
  });

  it("preserves input (track/z) order in jobs regardless of grouping", () => {
    const a = job("t1", "asset-1:2:30:0.066");
    const b = job("t2", "asset-2:2:30:0.066");
    const c = job("t3", "asset-1:2:30:0.066"); // same key as a

    const plan = planFrameDecodes([a, b, c]);

    expect(plan.jobs).toEqual([a, b, c]);
    // a and c share a group; b is its own.
    expect(plan.decodeGroups).toHaveLength(2);
    expect(plan.decodeGroups[0].jobs).toEqual([a, c]);
    expect(plan.decodeGroups[1].jobs).toEqual([b]);
    expect(countDedupedDecodes(plan)).toBe(1);
  });

  it("counts saved decodes across multiple multi-job groups", () => {
    const plan = planFrameDecodes([
      job("t1", "k1"),
      job("t2", "k1"),
      job("t3", "k1"), // 3 jobs on k1 -> saves 2
      job("t4", "k2"),
      job("t5", "k2"), // 2 jobs on k2 -> saves 1
      job("t6", null), // text -> no group
    ]);

    expect(countDedupedDecodes(plan)).toBe(3);
    expect(plan.decodeGroups).toHaveLength(2);
  });

  it("returns an empty plan for no jobs", () => {
    const plan = planFrameDecodes([]);
    expect(plan.jobs).toEqual([]);
    expect(plan.decodeGroups).toEqual([]);
    expect(countDedupedDecodes(plan)).toBe(0);
  });
});

// --- composition: plan + scheduler + store ---------------------------------

function fakeTexture(): Texture {
  return {
    destroyed: false,
    destroy(this: { destroyed: boolean }) {
      this.destroyed = true;
    },
  } as unknown as Texture;
}

interface HarnessOptions {
  /** Job keys whose getCurrentIntent should report stale (advanced generation). */
  staleKeys?: Set<string>;
}

function buildOps(options: HarnessOptions = {}): {
  ops: FrameTextureOps<{ id: string }>;
  decode: ReturnType<typeof vi.fn>;
  disposeUnclaimedFrame: ReturnType<typeof vi.fn>;
} {
  const staleKeys = options.staleKeys ?? new Set<string>();
  const decode = vi.fn(async (group: { decodeKey: string }) => ({
    id: `frame:${group.decodeKey}`,
  }));
  const disposeUnclaimedFrame = vi.fn();

  const ops: FrameTextureOps<{ id: string }> = {
    decode,
    createResource: (_decodeKey, frame) => {
      const texture = fakeTexture();
      return {
        texture,
        dispose: () => {
          (texture as unknown as { destroy: (v: boolean) => void }).destroy(
            true,
          );
          (frame as { closed?: boolean }).closed = true;
        },
      };
    },
    getCurrentIntent: (job): SourceFrameSyncIntent | null =>
      staleKeys.has(job.sourceFrame.key)
        ? { key: job.sourceFrame.key, generation: 99 }
        : { key: job.sourceFrame.key, generation: job.sourceFrame.generation },
    disposeUnclaimedFrame,
  };

  return { ops, decode, disposeUnclaimedFrame };
}

describe("RenderFramePlanner.acquireFrameTextures", () => {
  it("decodes once and shares one texture across duplicate-clip jobs", async () => {
    const scheduler = new SourceFrameDecodeScheduler<{ id: string }>();
    const store = new SharedTextureStore();
    const planner = new RenderFramePlanner(scheduler, store);

    const a = job("t1", "k");
    const b = job("t2", "k");
    const plan = planner.plan([a, b]);
    const { ops, decode } = buildOps();

    const handles = await planner.acquireFrameTextures(plan, ops);

    expect(decode).toHaveBeenCalledTimes(1);
    expect(handles.size).toBe(2);
    expect(handles.get(a)!.texture).toBe(handles.get(b)!.texture);
    expect(store.refCount("k")).toBe(2);
    expect(store.size).toBe(1);
  });

  it("decodes per distinct group", async () => {
    const scheduler = new SourceFrameDecodeScheduler<{ id: string }>();
    const store = new SharedTextureStore();
    const planner = new RenderFramePlanner(scheduler, store);

    const a = job("t1", "k1");
    const b = job("t2", "k2");
    const plan = planner.plan([a, b]);
    const { ops, decode } = buildOps();

    const handles = await planner.acquireFrameTextures(plan, ops);

    expect(decode).toHaveBeenCalledTimes(2);
    expect(handles.get(a)!.texture).not.toBe(handles.get(b)!.texture);
    expect(store.size).toBe(2);
  });

  it("omits stale jobs but still shares the decode with current jobs in the group", async () => {
    const scheduler = new SourceFrameDecodeScheduler<{ id: string }>();
    const store = new SharedTextureStore();
    const planner = new RenderFramePlanner(scheduler, store);

    const current = job("t1", "k");
    const stale = job("t2", "k");
    const plan = planner.plan([current, stale]);
    const { ops, decode, disposeUnclaimedFrame } = buildOps({
      staleKeys: new Set([stale.sourceFrame.key]),
    });

    const handles = await planner.acquireFrameTextures(plan, ops);

    expect(decode).toHaveBeenCalledTimes(1);
    expect(handles.has(current)).toBe(true);
    expect(handles.has(stale)).toBe(false);
    // A current job claimed the frame, so it is owned by the store — not freed.
    expect(disposeUnclaimedFrame).not.toHaveBeenCalled();
    expect(store.refCount("k")).toBe(1);
  });

  it("disposes the decoded frame when an entire group goes stale", async () => {
    const scheduler = new SourceFrameDecodeScheduler<{ id: string }>();
    const store = new SharedTextureStore();
    const planner = new RenderFramePlanner(scheduler, store);

    const a = job("t1", "k");
    const b = job("t2", "k");
    const plan = planner.plan([a, b]);
    const { ops, decode, disposeUnclaimedFrame } = buildOps({
      staleKeys: new Set([a.sourceFrame.key, b.sourceFrame.key]),
    });

    const handles = await planner.acquireFrameTextures(plan, ops);

    expect(decode).toHaveBeenCalledTimes(1);
    expect(handles.size).toBe(0);
    // Nobody wrapped the frame -> it is freed exactly once, store stays empty.
    expect(disposeUnclaimedFrame).toHaveBeenCalledTimes(1);
    expect(disposeUnclaimedFrame).toHaveBeenCalledWith({ id: "frame:k" });
    expect(store.size).toBe(0);
  });

  it("releasing every handle for a key frees the shared texture once", async () => {
    const scheduler = new SourceFrameDecodeScheduler<{ id: string }>();
    const store = new SharedTextureStore();
    const planner = new RenderFramePlanner(scheduler, store);

    const a = job("t1", "k");
    const b = job("t2", "k");
    const plan = planner.plan([a, b]);
    const { ops } = buildOps();

    const handles = await planner.acquireFrameTextures(plan, ops);
    const texture = handles.get(a)!.texture;

    handles.get(a)!.release();
    expect((texture as unknown as { destroyed: boolean }).destroyed).toBe(false);
    handles.get(b)!.release();
    expect((texture as unknown as { destroyed: boolean }).destroyed).toBe(true);
    expect(store.size).toBe(0);
  });

  it("rolls back handles from successful groups when another group fails", async () => {
    const scheduler = new SourceFrameDecodeScheduler<{ id: string }>();
    const store = new SharedTextureStore();
    const planner = new RenderFramePlanner(scheduler, store);

    const ok = job("t1", "k1");
    const bad = job("t2", "k2");
    const plan = planner.plan([ok, bad]);

    const { ops: baseOps } = buildOps();
    const createdTextures: Texture[] = [];
    const ops: FrameTextureOps<{ id: string }> = {
      ...baseOps,
      createResource: (decodeKey, frame) => {
        if (decodeKey === "k2") {
          throw new Error("wrap boom");
        }
        const resource = baseOps.createResource(decodeKey, frame);
        createdTextures.push(resource.texture);
        return resource;
      },
    };

    await expect(planner.acquireFrameTextures(plan, ops)).rejects.toThrow(
      "wrap boom",
    );

    // The successful group's texture was released, and the failing group's
    // frame was disposed — nothing leaks, store ends empty.
    expect(createdTextures).toHaveLength(1);
    expect(
      (createdTextures[0] as unknown as { destroyed: boolean }).destroyed,
    ).toBe(true);
    expect(store.size).toBe(0);
  });

  it("disposes the frame when wrapping fails before store ownership", async () => {
    const scheduler = new SourceFrameDecodeScheduler<{ id: string }>();
    const store = new SharedTextureStore();
    const planner = new RenderFramePlanner(scheduler, store);

    const a = job("t1", "k");
    const plan = planner.plan([a]);
    const { ops: baseOps, disposeUnclaimedFrame } = buildOps();
    const ops: FrameTextureOps<{ id: string }> = {
      ...baseOps,
      createResource: () => {
        throw new Error("wrap boom");
      },
    };

    await expect(planner.acquireFrameTextures(plan, ops)).rejects.toThrow(
      "wrap boom",
    );
    expect(disposeUnclaimedFrame).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });

  it("rejects overlapping acquisitions on one planner (no-overlap boundary)", async () => {
    const scheduler = new SourceFrameDecodeScheduler<{ id: string }>();
    const store = new SharedTextureStore();
    const planner = new RenderFramePlanner(scheduler, store);

    const control = deferred<{ id: string }>();
    const plan = planner.plan([job("t1", "k")]);
    const ops: FrameTextureOps<{ id: string }> = {
      ...buildOps().ops,
      decode: () => control.promise,
    };

    const first = planner.acquireFrameTextures(plan, ops);
    // Second call while the first is still in flight must be rejected.
    await expect(
      planner.acquireFrameTextures(plan, ops),
    ).rejects.toThrow("not re-entrant");

    control.resolve({ id: "frame:k" });
    await first;
    // Boundary clears after completion — a subsequent call is allowed.
    await expect(
      planner.acquireFrameTextures(planner.plan([job("t9", "k9")]), {
        ...buildOps().ops,
      }),
    ).resolves.toBeInstanceOf(Map);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
