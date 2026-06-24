import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "../../../../project";
import { useAssetStore } from "../../../../userAssets";
import type { GeneratedCreationMetadata } from "../../../../../types/Asset";
import {
  resolvePostprocessStitchFps,
  resolveSelectionMetadataFps,
  toPositiveFps,
  toPositiveInteger,
} from "../fps";

function metadata(
  inputs: GeneratedCreationMetadata["inputs"],
): GeneratedCreationMetadata {
  return { inputs } as GeneratedCreationMetadata;
}

describe("generation FPS utilities", () => {
  beforeEach(() => {
    useProjectStore.setState({
      config: {
        ...useProjectStore.getState().config,
        fps: 24,
      },
    });
    useAssetStore.setState({ assets: [] });
  });

  it("normalizes positive integers and FPS values", () => {
    expect(toPositiveInteger(1.6)).toBe(2);
    expect(toPositiveInteger(0)).toBeNull();
    expect(toPositiveInteger(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toPositiveFps(23.9764)).toBe(23.976);
    expect(toPositiveFps(-1)).toBeNull();
    expect(resolveSelectionMetadataFps({ fps: 30 } as never, 24)).toBe(30);
    expect(resolveSelectionMetadataFps({} as never, 24)).toBe(24);
  });

  it("prefers an explicit postprocessing FPS", async () => {
    await expect(
      resolvePostprocessStitchFps(
        metadata([]),
        { stitch_fps: 29.97 } as never,
      ),
    ).resolves.toBe(29.97);
  });

  it("uses timeline-selection FPS before dragged assets", async () => {
    useAssetStore.setState({
      assets: [{ id: "asset", fps: 60 }] as never,
    });
    await expect(
      resolvePostprocessStitchFps(
        metadata([
          {
            kind: "draggedAsset",
            parentAssetId: "asset",
          } as never,
          {
            kind: "timelineSelection",
            timelineSelection: { fps: 18 },
          } as never,
        ]),
        {} as never,
      ),
    ).resolves.toBe(18);
  });

  it("falls back to dragged asset or project FPS", async () => {
    useAssetStore.setState({
      assets: [{ id: "asset", fps: 60 }] as never,
    });
    await expect(
      resolvePostprocessStitchFps(
        metadata([
          {
            kind: "draggedAsset",
            parentAssetId: "asset",
          } as never,
        ]),
        {} as never,
      ),
    ).resolves.toBe(60);
    await expect(
      resolvePostprocessStitchFps(
        metadata([
          {
            kind: "draggedAsset",
            parentAssetId: "missing",
          } as never,
        ]),
        {} as never,
      ),
    ).resolves.toBe(24);
  });
});
