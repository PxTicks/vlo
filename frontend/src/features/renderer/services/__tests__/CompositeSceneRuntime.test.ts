import { describe, expect, it, vi } from "vitest";
import type { Renderer } from "pixi.js";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { FilterRenderContext } from "../../../transformations/catalogue/types";
import { CompositeSceneRuntimeManager } from "../CompositeSceneRuntime";
import { TemporalRenderCoordinator } from "../TemporalRenderCoordinator";
import type { ResolvedCompositeSource } from "../framePlanning";

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
      compositeId: "composite",
      placementId: "placement",
      revision: 1,
      bakeKey: "key",
      localPresentationTick: 500,
      logicalDimensions: { width: 641, height: 359 },
      fps: 30,
      content: { durationTicks: 1000, clips: [], tracks: [] },
      fallbackAssetId: null,
    };

    try {
      const texture = await manager.renderCompositeScene(source, [], {
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
          target: texture,
          clear: true,
          clearColor: [0, 0, 0, 0],
        }),
      );
      expect(texture).toMatchObject({ width: 641, height: 359 });
    } finally {
      plan.mockRestore();
      manager.dispose();
    }
  });

  it("rejects nested composite content before allocating a child runtime", async () => {
    const renderer = { render: vi.fn() } as unknown as Renderer;
    const manager = new CompositeSceneRuntimeManager(renderer);
    const source: ResolvedCompositeSource = {
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
});
