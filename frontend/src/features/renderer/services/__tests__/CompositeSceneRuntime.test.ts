import { describe, expect, it, vi } from "vitest";
import type { Renderer } from "pixi.js";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import { CompositeSceneRuntimeManager } from "../CompositeSceneRuntime";
import type { ResolvedCompositeSource } from "../framePlanning";

describe("CompositeSceneRuntimeManager", () => {
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
