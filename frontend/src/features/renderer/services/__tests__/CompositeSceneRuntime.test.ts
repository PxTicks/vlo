import { describe, expect, it, vi } from "vitest";
import type { Renderer } from "pixi.js";
import type { Asset } from "../../../../types/Asset";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { FilterRenderContext } from "../../../transformations/catalogue/types";
import { CompositeSceneRuntimeManager } from "../CompositeSceneRuntime";
import { TemporalRenderCoordinator } from "../TemporalRenderCoordinator";
import type { ResolvedCompositeSource } from "../framePlanning";

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

  it("deduplicates complete stateless work keys and accounts for every lease", async () => {
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

    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(second.value).toBe(first.value);
    expect(manager.getDiagnostics()).toMatchObject({
      runtimeCount: 1,
      outstandingLeases: 2,
      renderDedupHits: 1,
    });

    first.release();
    second.release();
    expect(manager.getDiagnostics()).toMatchObject({
      runtimeCount: 1,
      pooledRuntimeCount: 1,
      outstandingLeases: 0,
    });
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
});
