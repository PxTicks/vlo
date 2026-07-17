import { afterEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type { TimelineClip, TimelineTrack } from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline";
import { AdjustmentEffectResolver } from "../AdjustmentEffectResolver";
import type { DecoderWorkerPool } from "../DecoderWorkerPool";
import { TrackRenderEngine } from "../TrackRenderEngine";

/**
 * Regression: the per-clip presentation lookup caches the clip references it
 * was last built from, and is only invalidated via `setAdjustmentSource` (a
 * React effect). Renders that fire between a store edit and that effect must
 * still read the *live* clip — otherwise the renderer applies/notifies stale
 * transform values, which made committed panel edits (e.g. a blur slider)
 * visibly revert. The active-clip resolution therefore re-binds the lookup
 * result to the live `trackClips` by id.
 */
describe("TrackRenderEngine active-clip re-binding", () => {
  const engines: TrackRenderEngine[] = [];

  afterEach(() => {
    while (engines.length > 0) {
      engines.pop()?.dispose();
    }
  });

  const track: TimelineTrack = {
    id: "t1",
    type: "visual",
    label: "t1",
    isVisible: true,
    isMuted: false,
    isLocked: false,
  } as unknown as TimelineTrack;

  const baseClip = {
    id: "c1",
    trackId: "t1",
    type: "video",
    assetId: "a1",
    start: 0,
    timelineDuration: 100,
    offset: 0,
    transformedOffset: 0,
    transformedDuration: 100,
    croppedSourceDuration: 100,
    sourceDuration: 100,
    name: "c1",
  };

  const clipWithBlur = (amount: number): TimelineClip =>
    ({
      ...baseClip,
      transformations: [
        { id: "blur1", type: "blur", isEnabled: true, parameters: { amount } },
      ],
    }) as unknown as TimelineClip;

  it("returns the live clip, not the lookup's cached snapshot", () => {
    const resolver = new AdjustmentEffectResolver();
    const oldClip = clipWithBlur(0);
    // Lookup is built lazily from this snapshot.
    resolver.setAdjustmentSource([track], [oldClip], TICKS_PER_SECOND);

    const engine = new TrackRenderEngine(1, undefined, undefined, {
      trackId: "t1",
      adjustmentEffectResolver: resolver,
    });
    engines.push(engine);

    // First resolve builds/uses the cache against the old snapshot.
    const first = engine.resolveActiveClipAtPresentation([oldClip], 50);
    expect(first?.activeClip).toBe(oldClip);

    // Simulate a store edit (new clip object, new value) that has NOT yet been
    // pushed through setAdjustmentSource — the cache still holds `oldClip`.
    const newClip = clipWithBlur(12);
    const second = engine.resolveActiveClipAtPresentation([newClip], 50);

    expect(second?.activeClip).toBe(newClip);
    expect(
      (second?.activeClip.transformations?.[0].parameters as { amount: number })
        .amount,
    ).toBe(12);
    // Effective-tick math is unaffected (identity without an adjustment).
    expect(second?.effectiveTick).toBe(50);
  });

  it("prepares the canonical bake selected for a sentinel composite placement", () => {
    const lease = {
      prepare: vi.fn(),
      render: vi.fn(),
      disposeSource: vi.fn(),
      reportStall: vi.fn(async () => "released" as const),
      release: vi.fn(),
    };
    const decoderPool = {
      warmUp: vi.fn(),
      acquireLease: vi.fn(() => lease),
      dispose: vi.fn(),
    } satisfies DecoderWorkerPool;
    const engine = new TrackRenderEngine(1, undefined, undefined, {
      trackId: "t1",
      decoderPool,
    });
    engines.push(engine);
    const placement = {
      ...baseClip,
      assetId: "composite-live:composite-1",
      compositeId: "composite-1",
      compositeRevision: 1,
      transformations: [],
    } as TimelineClip;
    const bake = {
      id: "bake-1",
      hash: "bake-hash",
      name: "bake.webm",
      type: "video",
      src: "blob:bake",
      file: new File(["bake"], "bake.webm", { type: "video/webm" }),
      createdAt: 1,
    } satisfies Asset;
    const resolved = engine.resolveFrameJob({
      epoch: 1,
      presentationTick: 10,
      trackClips: [placement],
      maskClipsByParent: new Map(),
      assetsById: new Map([[bake.id, bake]]),
      logicalDimensions: { width: 1920, height: 1080 },
      fps: 30,
    });
    expect(resolved).not.toBeNull();
    const retargeted = engine.retargetResolvedFrameJobAsset(
      resolved!,
      bake,
      30,
    );

    expect(
      engine.prepareResolvedFrameJob(retargeted, [placement], [bake]),
    ).toBe(true);
  });
});
