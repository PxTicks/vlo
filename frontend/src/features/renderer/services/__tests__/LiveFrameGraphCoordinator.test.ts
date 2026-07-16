import { describe, expect, it, vi } from "vitest";
import { Texture } from "pixi.js";
import type { Asset } from "../../../../types/Asset";
import type {
  ClipTransform,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline";
import { extensionTransformationRegistry } from "../../../transformations/extensions/ExtensionTransformationRegistry";
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
  const presentedPolicies: FrameExecutionPolicy[] = [];
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
    resolveActiveClipAtPresentation: () => ({
      activeClip: clip,
      effectiveTick: 0,
      presentationStart: clip.start,
    }),
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
        presentedPolicies.push(_policy);
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

  return { clip, decode, engine, presentedPolicies, presentedTextures };
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

  it("approximates a scrub target before exact bounded warm-up", async () => {
    const registration = extensionTransformationRegistry.registerRuntime(
      {
        extension: { id: "test.live-temporal", version: "1.0.0" },
        signal: new AbortController().signal,
        own: (resource) => resource,
        report: () => undefined,
      },
      "history-filter",
      {
        type: "filter",
        filterName: "test.live-temporal/history-filter",
        label: "History filter",
        handler: () => undefined,
        uiConfig: { groups: [] },
        rendering: {
          timeDependency: "history",
          maxHistorySeconds: 2 / 30,
          maxStepSeconds: 1 / 30,
        },
      },
    );
    const coordinator = new LiveFrameGraphCoordinator();
    const harness = createEngineHarness("t1", "c1");
    harness.clip.start =
      10 * TICKS_PER_SECOND - TICKS_PER_SECOND / 30;
    (
      harness.clip as TimelineClip & { transformations: ClipTransform[] }
    ).transformations = [
      {
        id: "history-1",
        type: "filter",
        filterName: "test.live-temporal/history-filter",
        isEnabled: true,
        parameters: {},
      } as ClipTransform,
    ];
    coordinator.register({
      trackId: "t1",
      engine: harness.engine,
      getTrackClips: () => [harness.clip],
      getMaskClipsByParent: () => new Map(),
      getAssets: () =>
        [{ id: "asset-1", src: "a.mp4", type: "video", fps: 30 }] as Asset[],
      onResolvedJob: vi.fn(),
    });
    const submitWarmupFrame = vi.fn();
    const renderOptions = {
      fps: 30,
      logicalDimensions: { width: 1920, height: 1080 },
      visualTrackOrder: ["t1"],
      adjustmentEffectResolver: {
        deriveGroups: () => [],
      } as unknown as AdjustmentEffectResolver,
      submitWarmupFrame,
    };

    try {
      const approximate = await coordinator.renderFrame(
        10 * TICKS_PER_SECOND,
        { ...renderOptions, temporalPreviewQuality: "approximate" },
      );

      expect(submitWarmupFrame).not.toHaveBeenCalled();
      expect(harness.presentedPolicies).toHaveLength(1);
      expect(harness.presentedPolicies[0]?.render).toMatchObject({
        isWarmup: false,
        continuity: "sequential",
        sequenceId: 0,
      });

      harness.presentedPolicies.length = 0;
      const result = await coordinator.renderFrame(
        10 * TICKS_PER_SECOND,
        renderOptions,
      );

      expect(result).not.toBeNull();
      expect(submitWarmupFrame).toHaveBeenCalledTimes(1);
      expect(harness.presentedPolicies).toHaveLength(2);
      expect(
        harness.presentedPolicies.slice(0, 1).every(
          (policy) => policy.render?.isWarmup === true,
        ),
      ).toBe(true);
      expect(harness.presentedPolicies[1]?.render).toMatchObject({
        isWarmup: false,
        continuity: "sequential",
      });
      expect(result?.render.sequenceId).toBe(
        harness.presentedPolicies[0]?.render?.sequenceId,
      );

      (harness.clip as TimelineClip & { assetId: string }).assetId = "asset-2";
      submitWarmupFrame.mockClear();
      const replaced = await coordinator.renderFrame(
        10 * TICKS_PER_SECOND,
        renderOptions,
      );
      expect(replaced?.render.sequenceId).not.toBe(result?.render.sequenceId);
      expect(submitWarmupFrame).toHaveBeenCalledTimes(1);

    } finally {
      coordinator.dispose();
      registration.dispose();
    }
  });

  it("invalidates a planned sequence when live presentation does not commit", async () => {
    const coordinator = new LiveFrameGraphCoordinator();
    const harness = createEngineHarness("t1", "c1");
    const present = harness.engine.presentResolvedFrameJob as ReturnType<
      typeof vi.fn
    >;
    const attemptedPolicies: FrameExecutionPolicy[] = [];
    present
      .mockImplementationOnce(
        async (
          _job: ResolvedClipFrameJob,
          _handle: SharedTextureHandle | null,
          _assetsById: Map<string, Asset>,
          policy: FrameExecutionPolicy,
        ) => {
          attemptedPolicies.push(policy);
          const error = new Error("stale live frame");
          error.name = "AbortError";
          throw error;
        },
      )
      .mockImplementationOnce(
        async (
          _job: ResolvedClipFrameJob,
          _handle: SharedTextureHandle | null,
          _assetsById: Map<string, Asset>,
          policy: FrameExecutionPolicy,
        ) => {
          attemptedPolicies.push(policy);
          return true;
        },
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

    const failed = await coordinator.renderFrame(0, options);
    const recovered = await coordinator.renderFrame(0, options);

    expect(failed).toBeNull();
    expect(recovered).not.toBeNull();
    expect(attemptedPolicies).toHaveLength(2);
    expect(attemptedPolicies[1]?.render).toMatchObject({
      continuity: "discontinuous",
      isWarmup: false,
    });
    expect(attemptedPolicies[1]?.render?.sequenceId).not.toBe(
      attemptedPolicies[0]?.render?.sequenceId,
    );
    coordinator.dispose();
  });

  it("keeps sequence continuity when a temporal adjustment window activates", async () => {
    const registration = extensionTransformationRegistry.registerRuntime(
      {
        extension: { id: "test.adjustment-window", version: "1.0.0" },
        signal: new AbortController().signal,
        own: (resource) => resource,
        report: () => undefined,
      },
      "history-filter",
      {
        type: "filter",
        filterName: "test.adjustment-window/history-filter",
        label: "History filter",
        handler: () => undefined,
        uiConfig: { groups: [] },
        rendering: {
          timeDependency: "history",
          maxHistorySeconds: 2,
          maxStepSeconds: 1 / 30,
        },
      },
    );
    const transform = {
      id: "adjustment-history",
      type: "filter",
      filterName: "test.adjustment-window/history-filter",
      isEnabled: true,
      parameters: {},
    } as ClipTransform;
    const adjustment = {
      id: "adjustment-1",
      type: "adjustment",
      trackId: "adjustment-track",
      start: 5 * TICKS_PER_SECOND + TICKS_PER_SECOND / 30,
      timelineDuration: TICKS_PER_SECOND,
      transformations: [transform],
    } as TimelineClip;
    const group = {
      id: "adjustment-1@t1",
      sourceClipId: "adjustment-1",
      transformations: [transform],
      start: adjustment.start,
      timelineDuration: adjustment.timelineDuration,
      sampleTick: adjustment.start,
      trackIds: ["t1"],
      children: [],
    };
    const coordinator = new LiveFrameGraphCoordinator();
    const harness = createEngineHarness("t1", "c1");
    const futureClip = {
      ...harness.clip,
      id: "future-temporal",
      start: 10 * TICKS_PER_SECOND,
      transformations: [{ ...transform, id: "future-history" }],
    } as TimelineClip;
    coordinator.register({
      trackId: "t1",
      engine: harness.engine,
      getTrackClips: () => [harness.clip, futureClip],
      getMaskClipsByParent: () => new Map(),
      getAssets: () =>
        [{ id: "asset-1", src: "a.mp4", type: "video", fps: 30 }] as Asset[],
      onResolvedJob: vi.fn(),
    });
    const submitWarmupFrame = vi.fn();
    const options = {
      clips: [harness.clip, futureClip, adjustment],
      fps: 30,
      logicalDimensions: { width: 1920, height: 1080 },
      visualTrackOrder: ["t1"],
      adjustmentEffectResolver: {
        deriveGroups: (tick: number) =>
          tick >= adjustment.start ? [group] : [],
      } as unknown as AdjustmentEffectResolver,
      submitWarmupFrame,
    };

    try {
      const before = await coordinator.renderFrame(
        5 * TICKS_PER_SECOND,
        options,
      );
      const active = await coordinator.renderFrame(adjustment.start, options);

      expect(active?.render.sequenceId).toBe(before?.render.sequenceId);
      expect(active?.render.continuity).toBe("sequential");
      expect(submitWarmupFrame).not.toHaveBeenCalled();
    } finally {
      coordinator.dispose();
      registration.dispose();
    }
  });
});
