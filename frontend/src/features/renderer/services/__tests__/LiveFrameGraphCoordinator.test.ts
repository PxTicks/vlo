import { describe, expect, it, vi } from "vitest";
import { Texture } from "pixi.js";
import type { Asset } from "../../../../types/Asset";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { SourceFrameSyncIntent } from "../../utils/sourceFrameSync";
import type { AdjustmentEffectResolver } from "../AdjustmentEffectResolver";
import type { SharedTextureHandle } from "../SharedTextureStore";
import type { TrackRenderEngine } from "../TrackRenderEngine";
import {
  LiveFrameGraphCoordinator,
  type FrameExecutionPolicy,
  type ResolvedClipFrameJob,
} from "../framePlanning";

vi.mock("pixi.js", async () => {
  const actual = await vi.importActual<typeof import("pixi.js")>("pixi.js");
  return {
    ...actual,
    Texture: {
      ...actual.Texture,
      EMPTY: { width: 1, height: 1, destroy: vi.fn() },
      from: vi.fn(() => ({
        width: 640,
        height: 360,
        destroyed: false,
        destroy: vi.fn(),
      })),
    },
  };
});

function createEngineHarness(
  trackId: string,
  clipId: string,
  assetId = "asset-1",
) {
  let generation = 0;
  let currentIntent: SourceFrameSyncIntent | null = null;
  let retainedHandle: SharedTextureHandle | null = null;
  const decode = vi.fn(async () => {
    return { close: vi.fn() } as unknown as ImageBitmap;
  });
  const presentedTextures: Texture[] = [];
  const clip = {
    id: clipId,
    trackId,
    type: "video",
    assetId,
    start: 0,
    timelineDuration: 96000,
    transformations: [],
  } as unknown as TimelineClip;

  const engine = {
    resolveFrameJob(options: {
      epoch: number;
      logicalDimensions: { width: number; height: number };
      fps: number;
    }): ResolvedClipFrameJob {
      generation += 1;
      currentIntent = { key: `${clipId}:frame`, generation };
      return {
        id: `${options.epoch}:${trackId}:${clipId}`,
        trackId,
        activeClip: clip,
        effectiveTrackTick: 0,
        rawClipTick: 0,
        sourceFrame: {
          clipId,
          assetId,
          effectiveTrackTick: 0,
          rawClipTick: 0,
          sourceTimeTicks: 0,
          sourceTimeSeconds: 0,
          snappedTimeSeconds: 0,
          frameIndex: 0,
          fps: options.fps,
          key: currentIntent.key,
          decodeKey: `${assetId}:0:30:0`,
          generation,
        },
        maskClips: [],
        logicalDimensions: options.logicalDimensions,
        contentSize: options.logicalDimensions,
        fps: options.fps,
      };
    },
    presentBlankFrame: vi.fn(),
    prepareResolvedFrameJob: vi.fn(() => true),
    awaitResolvedFrameJobPreparation: vi.fn(async () => undefined),
    decodeResolvedSourceFrame: decode,
    getCurrentPlannedSourceFrameIntent: () => currentIntent,
    presentResolvedFrameJob: vi.fn(
      async (
        _job: ResolvedClipFrameJob,
        handle: SharedTextureHandle | null,
        _assetsById: Map<string, Asset>,
        _policy: FrameExecutionPolicy,
      ) => {
        if (handle) {
          presentedTextures.push(handle.texture);
          const previous = retainedHandle;
          retainedHandle = handle;
          previous?.release();
        }
        return true;
      },
    ),
  } as unknown as TrackRenderEngine;

  return { clip, decode, engine, presentedTextures };
}

describe("LiveFrameGraphCoordinator", () => {
  it("shares duplicate source work and reuses the retained frame for paused edits", async () => {
    const coordinator = new LiveFrameGraphCoordinator();
    const first = createEngineHarness("t1", "c1");
    const second = createEngineHarness("t2", "c2");
    const assets = [
      {
        id: "asset-1",
        src: "asset.mp4",
        type: "video",
        fps: 30,
      },
    ] as Asset[];
    for (const harness of [first, second]) {
      coordinator.register({
        trackId: harness.clip.trackId,
        engine: harness.engine,
        getTrackClips: () => [harness.clip],
        getMaskClipsByParent: () => new Map(),
        getAssets: () => assets,
        onResolvedJob: vi.fn(),
      });
    }
    const options = {
      fps: 30,
      logicalDimensions: { width: 1920, height: 1080 },
      visualTrackOrder: ["t1", "t2"],
      adjustmentEffectResolver: {
        deriveGroups: () => [],
      } as unknown as AdjustmentEffectResolver,
    };

    const initial = await coordinator.renderFrame(0, options);
    expect(initial).not.toBeNull();
    expect(first.decode).toHaveBeenCalledTimes(1);
    expect(second.decode).not.toHaveBeenCalled();
    expect(first.presentedTextures[0]).toBe(second.presentedTextures[0]);

    coordinator.requestFrame(0);
    const pausedEdit = await coordinator.renderFrame(0, options);
    expect(pausedEdit?.execution.diagnostics.cacheHits).toBe(1);
    expect(first.decode).toHaveBeenCalledTimes(1);
    expect(second.decode).not.toHaveBeenCalled();

    coordinator.dispose();
  });

  it("still commits when a frame is requested mid-decode", async () => {
    const coordinator = new LiveFrameGraphCoordinator();
    const harness = createEngineHarness("t1", "c1");
    let releaseDecode: (bitmap: ImageBitmap) => void = () => {};
    (harness.decode as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDecode = () =>
            resolve({ close: vi.fn() } as unknown as ImageBitmap);
        }),
    );
    coordinator.register({
      trackId: "t1",
      engine: harness.engine,
      getTrackClips: () => [harness.clip],
      getMaskClipsByParent: () => new Map(),
      getAssets: () =>
        [{ id: "asset-1", src: "a.mp4", type: "video", fps: 30 }] as Asset[],
      onResolvedJob: vi.fn(),
    });
    const options = {
      fps: 30,
      logicalDimensions: { width: 1920, height: 1080 },
      visualTrackOrder: ["t1"],
      adjustmentEffectResolver: {
        deriveGroups: () => [],
      } as unknown as AdjustmentEffectResolver,
    };

    const pending = coordinator.renderFrame(0, options);
    // A per-track React effect fires requestFrame while the decode is awaiting.
    coordinator.requestFrame(0);
    releaseDecode({ close: vi.fn() } as unknown as ImageBitmap);
    const result = await pending;

    expect(result).not.toBeNull();
    expect(harness.presentedTextures.length).toBe(1);
    coordinator.dispose();
  });

  it("defers an unprepared source without blocking ready tracks", async () => {
    const coordinator = new LiveFrameGraphCoordinator();
    const ready = createEngineHarness("t1", "c1", "asset-ready");
    const hydrating = createEngineHarness(
      "t2",
      "c2",
      "asset-hydrating",
    );
    const hydratingPrepare =
      hydrating.engine.prepareResolvedFrameJob as ReturnType<typeof vi.fn>;
    hydratingPrepare.mockReturnValue(false);
    const assets = [
      {
        id: "asset-ready",
        src: "ready.mp4",
        type: "video",
        fps: 30,
      },
      {
        id: "asset-hydrating",
        src: "hydrating.mp4",
        type: "video",
        fps: 30,
      },
    ] as Asset[];
    for (const harness of [ready, hydrating]) {
      coordinator.register({
        trackId: harness.clip.trackId,
        engine: harness.engine,
        getTrackClips: () => [harness.clip],
        getMaskClipsByParent: () => new Map(),
        getAssets: () => assets,
        onResolvedJob: vi.fn(),
      });
    }
    const options = {
      fps: 30,
      logicalDimensions: { width: 1920, height: 1080 },
      visualTrackOrder: ["t1", "t2"],
      adjustmentEffectResolver: {
        deriveGroups: () => [],
      } as unknown as AdjustmentEffectResolver,
    };

    const first = await coordinator.renderFrame(0, options);
    expect(first).not.toBeNull();
    expect(ready.decode).toHaveBeenCalledTimes(1);
    expect(hydrating.decode).not.toHaveBeenCalled();

    hydratingPrepare.mockReturnValue(true);
    const hydrated = await coordinator.renderFrame(0, options);
    expect(hydrated).not.toBeNull();
    expect(hydrating.decode).toHaveBeenCalledTimes(1);

    coordinator.dispose();
  });
});
