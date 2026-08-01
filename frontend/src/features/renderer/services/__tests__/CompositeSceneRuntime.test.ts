import { describe, expect, it, vi } from "vitest";
import type { Renderer } from "pixi.js";
import type { Asset } from "../../../../types/Asset";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { FilterRenderContext } from "../../../transformations/catalogue/types";
import { CompositeSceneRuntimeManager } from "../CompositeSceneRuntime";
import { TemporalRenderCoordinator } from "../TemporalRenderCoordinator";
import { BatchFrameGraphExecutor } from "../framePlanning/BatchFrameGraphExecutor";
import type { ResolvedCompositeSource } from "../framePlanning";
import type { DecoderWorkerPool } from "../DecoderWorkerPool";

const userAssetMocks = vi.hoisted(() => ({
  getAssetInput: vi.fn(),
}));

vi.mock("../../../userAssets", () => ({
  getAssetInput: userAssetMocks.getAssetInput,
  ensureAssetSourceLoaded: vi.fn(),
}));

function renderContext(
  presentationTimeTicks: number,
  isWarmup: boolean,
): FilterRenderContext {
  return {
    sequenceId: 1,
    sampleId: presentationTimeTicks + 1,
    mode: "export",
    continuity: isWarmup ? "discontinuous" : "sequential",
    presentationTimeTicks,
    visualTimeTicks: presentationTimeTicks,
    sourceTimeTicks: presentationTimeTicks,
    deltaTimeTicks: isWarmup ? null : 100,
    fps: 30,
    isWarmup,
  };
}

describe("CompositeSceneRuntimeManager", () => {
  it("renders child-local temporal warm-up before exposing the target texture", async () => {
    const renderer = { render: vi.fn() } as unknown as Renderer;
    const manager = new CompositeSceneRuntimeManager(renderer);
    const warmup = renderContext(400, true);
    const target = renderContext(500, false);
    const plan = vi
      .spyOn(TemporalRenderCoordinator.prototype, "plan")
      .mockReturnValue({ warmup: [warmup], target, isDiscontinuous: true });
    const source: ResolvedCompositeSource = {
      mode: "live",
      fallbackReason: "not-ready",
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "composite",
      placementId: "placement",
      revision: 1,
      bakeKey: "key",
      localPresentationTick: 500,
      logicalDimensions: { width: 640, height: 360 },
      fps: 30,
      content: { durationTicks: 1000, clips: [], tracks: [] },
      fallbackAssetId: null,
    };

    try {
      const lease = await manager.renderCompositeScene(source, [], {
        mode: "export",
      });

      expect(plan).toHaveBeenCalledWith(
        expect.objectContaining({
          presentationTick: 500,
          fps: 30,
          mode: "export",
          earliestTick: 0,
        }),
      );
      expect(renderer.render).toHaveBeenCalledTimes(2);
      expect(renderer.render).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          target: lease.value,
          clear: true,
          clearColor: [0, 0, 0, 0],
        }),
      );
      expect(lease.value).toMatchObject({ width: 1280, height: 720 });
      lease.release();
      expect(manager.getDiagnostics()).toMatchObject({
        childPlanning: {
          samples: 2,
          warmupSamples: 1,
          targetSamples: 1,
          cancelledSamples: 0,
          failedSamples: 0,
        },
      });
      expect(manager.getDiagnostics().childPlanning.samples).toBe(2);
      expect(manager.takeDiagnostics().childPlanning.samples).toBe(2);
      expect(manager.getDiagnostics().childPlanning.samples).toBe(0);
    } finally {
      plan.mockRestore();
      manager.dispose();
    }
  });

  it("does not replay child history for approximate scrub previews", async () => {
    const renderer = { render: vi.fn() } as unknown as Renderer;
    const manager = new CompositeSceneRuntimeManager(renderer);
    const plan = vi.spyOn(TemporalRenderCoordinator.prototype, "plan");
    const approximate = vi.spyOn(
      TemporalRenderCoordinator.prototype,
      "createApproximatePreviewContext",
    );
    const source: ResolvedCompositeSource = {
      mode: "live",
      fallbackReason: "not-ready",
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "composite",
      placementId: "placement",
      revision: 1,
      bakeKey: "key",
      localPresentationTick: 500,
      logicalDimensions: { width: 1920, height: 1080 },
      fps: 30,
      content: { durationTicks: 1000, clips: [], tracks: [] },
      fallbackAssetId: null,
    };

    try {
      const lease = await manager.renderCompositeScene(source, [], {
        mode: "live",
        epoch: 1,
        temporalPreviewQuality: "approximate",
      });

      expect(plan).not.toHaveBeenCalled();
      expect(approximate).toHaveBeenCalledWith(500, 30);
      expect(renderer.render).toHaveBeenCalledTimes(1);
      lease.release();
    } finally {
      plan.mockRestore();
      approximate.mockRestore();
      manager.dispose();
    }
  });

  it("threads live epoch cancellation into the child executor", async () => {
    const renderer = { render: vi.fn() } as unknown as Renderer;
    let epochChecks = 0;
    let acceptAllEpochs = false;
    const manager = new CompositeSceneRuntimeManager(renderer, undefined, {
      // Let both manager guards pass, then supersede inside child execution.
      isLiveEpochCurrent: () =>
        acceptAllEpochs || (epochChecks += 1) <= 2,
    });
    const source: ResolvedCompositeSource = {
      mode: "live",
      fallbackReason: "not-ready",
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "composite",
      placementId: "placement",
      revision: 1,
      bakeKey: "key",
      localPresentationTick: 500,
      logicalDimensions: { width: 640, height: 360 },
      fps: 30,
      content: { durationTicks: 1000, clips: [], tracks: [] },
      fallbackAssetId: null,
    };

    await expect(
      manager.renderCompositeScene(source, [], {
        mode: "live",
        epoch: 1,
        temporalPreviewQuality: "approximate",
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(renderer.render).not.toHaveBeenCalled();
    expect(manager.getDiagnostics().childPlanning).toMatchObject({
      samples: 0,
      cancelledSamples: 1,
      failedSamples: 0,
    });
    expect(manager.getDiagnostics()).toMatchObject({
      runtimeCount: 0,
    });

    acceptAllEpochs = true;
    const retry = await manager.renderCompositeScene(
      { ...source, localPresentationTick: 600 },
      [],
      {
        mode: "live",
        epoch: 2,
        temporalPreviewQuality: "approximate",
      },
    );
    retry.release();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(manager.getDiagnostics()).toMatchObject({
      runtimeCount: 1,
    });
    manager.dispose();
  });

  it("retires partial temporal history after abort and fully replays on retry", async () => {
    const controller = new AbortController();
    const render = vi.fn(() => {
      if (render.mock.calls.length === 3) {
        controller.abort();
      }
    });
    const renderer = { render } as unknown as Renderer;
    const manager = new CompositeSceneRuntimeManager(renderer);
    const warmup = [100, 200, 300, 400, 500].map((tick) =>
      renderContext(tick, true),
    );
    const target = renderContext(600, false);
    const plan = vi
      .spyOn(TemporalRenderCoordinator.prototype, "plan")
      .mockReturnValue({ warmup, target, isDiscontinuous: true });
    const source: ResolvedCompositeSource = {
      mode: "live",
      fallbackReason: "not-ready",
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "temporal",
      placementId: "placement",
      revision: 1,
      bakeKey: "key",
      localPresentationTick: 600,
      logicalDimensions: { width: 640, height: 360 },
      fps: 30,
      content: { durationTicks: 1000, clips: [], tracks: [] },
      fallbackAssetId: null,
      isStateless: false,
    };

    try {
      await expect(
        manager.renderCompositeScene(source, [], {
          mode: "live",
          epoch: 1,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(manager.getDiagnostics()).toMatchObject({
        runtimeCount: 0,
        childPlanning: {
          samples: 3,
          warmupSamples: 3,
          cancelledSamples: 1,
        },
      });

      const retry = await manager.renderCompositeScene(source, [], {
        mode: "live",
        epoch: 2,
        signal: new AbortController().signal,
      });
      expect(plan).toHaveBeenCalledTimes(2);
      expect(renderer.render).toHaveBeenCalledTimes(9);
      expect(manager.getDiagnostics()).toMatchObject({
        runtimeCount: 1,
        childPlanning: {
          samples: 9,
          warmupSamples: 8,
          targetSamples: 1,
          cancelledSamples: 1,
        },
      });
      retry.release();
    } finally {
      plan.mockRestore();
      manager.dispose();
    }
  });

  it("retains prepared decoder sessions while replacing an aborted render generation", async () => {
    const controller = new AbortController();
    const renderer = {
      render: vi.fn(() => {
        if (renderer.render.mock.calls.length === 1) {
          controller.abort();
        }
      }),
    } as unknown as Renderer & { render: ReturnType<typeof vi.fn> };
    const leaseReleases: Array<ReturnType<typeof vi.fn>> = [];
    const decoderPool = {
      warmUp: vi.fn(),
      acquireLease: vi.fn((_meta, events) => {
        const release = vi.fn();
        leaseReleases.push(release);
        return {
          prepare: vi.fn((request) => {
            events.onReady(request.clipId, request.kind);
            return "posted" as const;
          }),
          render: vi.fn((request) => {
            events.onFrame({
              clipId: request.clipId,
              bitmap: null,
              time: request.time,
              transformTime: request.transformTime,
              requestId: request.requestId,
            });
          }),
          disposeSource: vi.fn(),
          reportStall: vi.fn(async () => "released" as const),
          release,
        };
      }),
      disposeSession: vi.fn(),
      dispose: vi.fn(),
    } satisfies DecoderWorkerPool;
    const manager = new CompositeSceneRuntimeManager(renderer, decoderPool);
    const plan = vi
      .spyOn(TemporalRenderCoordinator.prototype, "plan")
      .mockReturnValue({
        warmup: [renderContext(100, true), renderContext(200, true)],
        target: renderContext(300, false),
        isDiscontinuous: true,
      });
    const asset = {
      id: "source",
      hash: "hash",
      name: "source.mp4",
      type: "video",
      src: "blob:source",
      file: new File(["video"], "source.mp4", { type: "video/mp4" }),
      createdAt: 1,
    } satisfies Asset;
    userAssetMocks.getAssetInput.mockResolvedValue({
      getPrimaryVideoTrack: vi.fn().mockResolvedValue({
        displayWidth: 1280,
        displayHeight: 720,
      }),
    });
    const source: ResolvedCompositeSource = {
      mode: "live",
      fallbackReason: "not-ready",
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "temporal-video",
      placementId: "placement",
      revision: 1,
      bakeKey: "key",
      localPresentationTick: 300,
      logicalDimensions: { width: 1280, height: 720 },
      fps: 30,
      content: {
        durationTicks: 1000,
        tracks: [
          {
            id: "track",
            type: "visual",
            label: "Video",
            isVisible: true,
            isMuted: false,
            isLocked: false,
          },
        ],
        clips: [
          {
            id: "clip",
            trackId: "track",
            type: "video",
            name: "Clip",
            assetId: asset.id,
            sourceDuration: 1000,
            start: 0,
            timelineDuration: 1000,
            offset: 0,
            transformedDuration: 1000,
            transformedOffset: 0,
            croppedSourceDuration: 1000,
            transformations: [],
            components: [],
          } as TimelineClip,
        ],
      },
      fallbackAssetId: null,
      isStateless: false,
    };

    try {
      await expect(
        manager.renderCompositeScene(source, [asset], {
          mode: "live",
          epoch: 1,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(leaseReleases[0]).toHaveBeenCalledWith({
        retainPreparedSources: true,
      });

      const retry = await manager.renderCompositeScene(source, [asset], {
        mode: "live",
        epoch: 2,
        signal: new AbortController().signal,
      });
      retry.release();
      const resized = await manager.renderCompositeScene(source, [asset], {
        mode: "live",
        epoch: 3,
        signal: new AbortController().signal,
        outputDimensions: { width: 640, height: 360 },
      });
      resized.release();

      expect(decoderPool.acquireLease).toHaveBeenCalledTimes(3);
      const firstSessionKey =
        decoderPool.acquireLease.mock.calls[0]?.[0]?.sessionKey;
      const secondSessionKey =
        decoderPool.acquireLease.mock.calls[1]?.[0]?.sessionKey;
      const thirdSessionKey =
        decoderPool.acquireLease.mock.calls[2]?.[0]?.sessionKey;
      expect(firstSessionKey).toBeTypeOf("string");
      expect(secondSessionKey).toBe(firstSessionKey);
      expect(thirdSessionKey).toBe(firstSessionKey);
      expect(leaseReleases[1]).toHaveBeenCalledWith({
        retainPreparedSources: true,
      });
      expect(decoderPool.disposeSession).not.toHaveBeenCalled();
    } finally {
      plan.mockRestore();
      manager.dispose();
      userAssetMocks.getAssetInput.mockReset();
    }

    expect(leaseReleases[2]).toHaveBeenCalledWith({
      retainPreparedSources: false,
    });
  });

  it("uses the largest referenced source resolution for its physical raster", async () => {
    const renderer = { render: vi.fn() } as unknown as Renderer;
    const manager = new CompositeSceneRuntimeManager(renderer);
    const plan = vi
      .spyOn(TemporalRenderCoordinator.prototype, "plan")
      .mockReturnValue({
        warmup: [],
        target: renderContext(0, false),
        isDiscontinuous: true,
      });
    const asset = {
      id: "source",
      hash: "hash",
      name: "source.mp4",
      type: "video",
      src: "source.mp4",
      createdAt: 1,
    } satisfies Asset;
    userAssetMocks.getAssetInput.mockResolvedValue({
      getPrimaryVideoTrack: vi.fn().mockResolvedValue({
        displayWidth: 1920,
        displayHeight: 1080,
      }),
    });
    const source: ResolvedCompositeSource = {
      mode: "live",
      fallbackReason: "not-ready",
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "composite",
      placementId: "placement",
      revision: 1,
      bakeKey: "key",
      localPresentationTick: 0,
      logicalDimensions: { width: 640, height: 360 },
      fps: 30,
      content: {
        durationTicks: 1000,
        clips: [
          {
            id: "source-clip",
            trackId: "missing-track",
            type: "video",
            assetId: asset.id,
          } as unknown as TimelineClip,
        ],
        tracks: [
          {
            id: "missing-track",
            type: "visual",
            label: "Hidden",
            isVisible: false,
            isMuted: false,
            isLocked: false,
          },
        ],
      },
      fallbackAssetId: null,
    };

    try {
      const lease = await manager.renderCompositeScene(source, [asset], {
        mode: "export",
      });

      expect(userAssetMocks.getAssetInput).toHaveBeenCalledWith(asset.id);
      expect(lease.value).toMatchObject({ width: 1920, height: 1080 });
      lease.release();
    } finally {
      userAssetMocks.getAssetInput.mockReset();
      plan.mockRestore();
      manager.dispose();
    }
  });

  it("hydrates live sources before applying output demand and replaces the runtime after resize", async () => {
    const renderer = { render: vi.fn() } as unknown as Renderer;
    const manager = new CompositeSceneRuntimeManager(renderer);
    const asset = {
      id: "preview-source",
      hash: "hash",
      name: "preview-source.mp4",
      type: "video",
      src: "preview-source.mp4",
      createdAt: 1,
    } satisfies Asset;
    userAssetMocks.getAssetInput.mockResolvedValue({
      getPrimaryVideoTrack: vi.fn().mockResolvedValue({
        displayWidth: 1920,
        displayHeight: 1080,
      }),
    });
    const source: ResolvedCompositeSource = {
      mode: "live",
      fallbackReason: "not-ready",
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "preview-sized",
      placementId: "placement",
      revision: 1,
      bakeKey: "key",
      localPresentationTick: 0,
      logicalDimensions: { width: 1920, height: 1080 },
      fps: 30,
      content: {
        durationTicks: 1000,
        clips: [
          {
            id: "preview-source-clip",
            trackId: "hidden-track",
            type: "video",
            assetId: asset.id,
          } as unknown as TimelineClip,
        ],
        tracks: [
          {
            id: "hidden-track",
            type: "visual",
            label: "Hidden",
            isVisible: false,
            isMuted: false,
            isLocked: false,
          },
        ],
      },
      fallbackAssetId: null,
    };

    const first = await manager.renderCompositeScene(source, [asset], {
      mode: "live",
      epoch: 1,
      temporalPreviewQuality: "approximate",
      outputDimensions: { width: 640, height: 360 },
    });
    const resized = await manager.renderCompositeScene(source, [asset], {
      mode: "live",
      epoch: 2,
      temporalPreviewQuality: "approximate",
      outputDimensions: { width: 960, height: 540 },
    });
    const sourceCapped = await manager.renderCompositeScene(source, [asset], {
      mode: "live",
      epoch: 3,
      temporalPreviewQuality: "approximate",
      outputDimensions: { width: 3840, height: 2160 },
    });

    expect(userAssetMocks.getAssetInput).toHaveBeenCalledOnce();
    expect(userAssetMocks.getAssetInput).toHaveBeenCalledWith(asset.id);
    expect(first.value).toMatchObject({
      width: 640,
      height: 360,
      source: { pixelWidth: 640, pixelHeight: 360 },
    });
    expect(resized.value).toMatchObject({
      width: 960,
      height: 540,
      source: { pixelWidth: 960, pixelHeight: 540 },
    });
    expect(sourceCapped.value).toMatchObject({
      width: 1920,
      height: 1080,
      source: { pixelWidth: 1920, pixelHeight: 1080 },
    });
    expect(resized.value).not.toBe(first.value);
    expect(sourceCapped.value).not.toBe(resized.value);
    expect(manager.getDiagnostics()).toMatchObject({
      runtimeCount: 3,
      outputTextureBytes:
        (640 * 360 + 960 * 540 + 1920 * 1080) * 4,
      outstandingLeases: 3,
    });

    first.release();
    expect(manager.getDiagnostics()).toMatchObject({
      runtimeCount: 2,
      outputTextureBytes: (960 * 540 + 1920 * 1080) * 4,
      outstandingLeases: 2,
    });
    resized.release();
    sourceCapped.release();
    userAssetMocks.getAssetInput.mockReset();
    manager.dispose();
  });

  it("rejects nested composite content before allocating a child runtime", async () => {
    const renderer = { render: vi.fn() } as unknown as Renderer;
    const manager = new CompositeSceneRuntimeManager(renderer);
    const source: ResolvedCompositeSource = {
      mode: "live",
      fallbackReason: "not-ready",
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "outer",
      placementId: "outer-placement",
      revision: 1,
      bakeKey: "outer-key",
      localPresentationTick: 0,
      logicalDimensions: { width: 1920, height: 1080 },
      fps: 30,
      content: {
        durationTicks: 100,
        clips: [
          {
            id: "nested-placement",
            trackId: "track",
            type: "video",
            assetId: "nested-bake",
            compositeId: "nested",
          } as unknown as TimelineClip,
        ],
      },
      fallbackAssetId: null,
    };

    await expect(
      manager.renderCompositeScene(source, [], { mode: "export" }),
    ).rejects.toThrow(/Nested composite content is not supported/);
    expect(renderer.render).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("reuses one stateless placement runtime across changing ticks", async () => {
    const renderer = { render: vi.fn() } as unknown as Renderer;
    const manager = new CompositeSceneRuntimeManager(renderer);
    const source: ResolvedCompositeSource = {
      mode: "live",
      fallbackReason: "not-ready",
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "shared",
      placementId: "placement-a",
      revision: 1,
      bakeKey: "shared-key",
      localPresentationTick: 100,
      logicalDimensions: { width: 640, height: 360 },
      fps: 30,
      content: { durationTicks: 1000, clips: [], tracks: [] },
      fallbackAssetId: null,
      isStateless: true,
    };

    const first = await manager.renderCompositeScene(source, [], {
      mode: "export",
    });
    first.release();
    const second = await manager.renderCompositeScene(
      { ...source, localPresentationTick: 200 },
      [],
      { mode: "export" },
    );
    const duplicate = await manager.renderCompositeScene(
      { ...source, localPresentationTick: 200 },
      [],
      { mode: "export" },
    );

    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(second.value).toBe(first.value);
    expect(duplicate.value).toBe(second.value);
    expect(manager.getDiagnostics()).toMatchObject({
      runtimeCount: 1,
      outstandingLeases: 2,
      renderDedupHits: 1,
    });

    second.release();
    duplicate.release();
    expect(manager.getDiagnostics()).toMatchObject({
      runtimeCount: 1,
      pooledRuntimeCount: 1,
      outstandingLeases: 0,
    });
    manager.dispose();
  });

  it("keeps stateless outputs private across placements at the same tick", async () => {
    const renderer = { render: vi.fn() } as unknown as Renderer;
    const manager = new CompositeSceneRuntimeManager(renderer);
    const source: ResolvedCompositeSource = {
      mode: "live",
      fallbackReason: "not-ready",
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "shared",
      placementId: "placement-a",
      revision: 1,
      bakeKey: "shared-key",
      localPresentationTick: 100,
      logicalDimensions: { width: 640, height: 360 },
      fps: 30,
      content: { durationTicks: 1000, clips: [], tracks: [] },
      fallbackAssetId: null,
      isStateless: true,
    };

    const first = await manager.renderCompositeScene(source, [], {
      mode: "export",
    });
    const second = await manager.renderCompositeScene(
      { ...source, placementId: "placement-b" },
      [],
      { mode: "export" },
    );

    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(second.value).not.toBe(first.value);
    expect(manager.getDiagnostics()).toMatchObject({
      runtimeCount: 2,
      outstandingLeases: 2,
      renderDedupHits: 0,
    });

    first.release();
    second.release();
    manager.dispose();
  });

  it("retains leased outputs beyond budget and evicts them immediately on release", async () => {
    const renderer = { render: vi.fn() } as unknown as Renderer;
    const manager = new CompositeSceneRuntimeManager(renderer, undefined, {
      maxRuntimeCount: 1,
      maxTextureBytes: 4,
    });
    const source: ResolvedCompositeSource = {
      mode: "live",
      fallbackReason: "not-ready",
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "budgeted",
      placementId: "placement",
      revision: 1,
      bakeKey: "budget-key",
      localPresentationTick: 0,
      logicalDimensions: { width: 640, height: 360 },
      fps: 30,
      content: { durationTicks: 100, clips: [], tracks: [] },
      fallbackAssetId: null,
      isStateless: false,
    };

    const lease = await manager.renderCompositeScene(source, [], {
      mode: "export",
    });
    expect(manager.getDiagnostics()).toMatchObject({
      runtimeCount: 1,
      outstandingLeases: 1,
    });

    lease.release();
    expect(manager.getDiagnostics()).toMatchObject({
      runtimeCount: 0,
      textureBytes: 0,
      outstandingLeases: 0,
    });
    manager.dispose();
  });

  it("reports child source bytes without charging them to the output pool budget", async () => {
    const resourceDiagnostics = vi
      .spyOn(BatchFrameGraphExecutor.prototype, "getResourceDiagnostics")
      .mockReturnValue({
        residentSourceResources: 3,
        residentSourceTextureBytes: 64 * 1024 * 1024,
        outstandingLeases: 3,
      });
    const renderer = { render: vi.fn() } as unknown as Renderer;
    const manager = new CompositeSceneRuntimeManager(renderer, undefined, {
      maxRuntimeCount: 12,
      maxTextureBytes: 8 * 1024 * 1024,
    });
    const source: ResolvedCompositeSource = {
      mode: "live",
      fallbackReason: "not-ready",
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "budget-capacity",
      placementId: "placement-a",
      revision: 1,
      bakeKey: "key",
      localPresentationTick: 0,
      logicalDimensions: { width: 640, height: 360 },
      fps: 30,
      content: { durationTicks: 100, clips: [], tracks: [] },
      fallbackAssetId: null,
      isStateless: false,
    };

    try {
      const first = await manager.renderCompositeScene(source, [], {
        mode: "export",
      });
      first.release();
      const second = await manager.renderCompositeScene(
        { ...source, placementId: "placement-b" },
        [],
        { mode: "export" },
      );
      second.release();

      expect(manager.getDiagnostics()).toMatchObject({
        runtimeCount: 2,
        outputTextureBytes: 2 * 1280 * 720 * 4,
        childResidentSourceResources: 6,
        childResidentSourceTextureBytes: 128 * 1024 * 1024,
      });
      expect(manager.getDiagnostics().textureBytes).toBeGreaterThan(
        8 * 1024 * 1024,
      );
    } finally {
      manager.dispose();
      resourceDiagnostics.mockRestore();
    }
  });
});
