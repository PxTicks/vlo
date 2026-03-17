import { beforeEach, describe, expect, it } from "vitest";
import type { Asset } from "../../../../types/Asset";
import { useProjectStore } from "../../../project/useProjectStore";
import { TICKS_PER_SECOND } from "../../constants";
import { createClipFromAsset } from "../clipFactory";
import { deriveClipTransformsFromAsset } from "../metadataTransforms";

function createAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-generated",
    hash: "hash-generated",
    name: "generated.mp4",
    type: "video",
    src: "blob:generated",
    createdAt: 1,
    ...overrides,
  };
}

describe("metadataTransforms", () => {
  beforeEach(() => {
    const currentConfig = useProjectStore.getState().config;
    useProjectStore.setState({
      config: {
        ...currentConfig,
        aspectRatio: "16:9",
        fps: 30,
        layoutMode: "compact",
      },
    });
  });

  it("derives position and scale transforms from explicit crop geometry", () => {
    const asset = createAsset({
      creationMetadata: {
        source: "generated",
        workflowName: "Mask Crop Workflow",
        inputs: [],
        maskCropMetadata: {
          mode: "cropped",
          crop_position: [100, 50],
          crop_size: [200, 100],
          container_size: [1000, 500],
          scale: 0.2,
        },
      },
    });

    const transforms = deriveClipTransformsFromAsset(asset);

    expect(transforms).toEqual([
      expect.objectContaining({
        type: "position",
        isEnabled: true,
        parameters: {
          x: -300,
          y: -150,
        },
      }),
      expect.objectContaining({
        type: "scale",
        isEnabled: true,
        parameters: {
          x: 0.2,
          y: 0.2,
          isLinked: true,
        },
      }),
    ]);
  });

  it("uses the provided fallback container size for legacy crop metadata", () => {
    const asset = createAsset({
      creationMetadata: {
        source: "generated",
        workflowName: "Legacy Crop Workflow",
        inputs: [],
        maskCropMetadata: {
          mode: "cropped",
          crop_position: [240, 135],
          scale: 0.25,
        },
      },
    });

    const transforms = deriveClipTransformsFromAsset(asset, {
      fallbackContainerSize: { width: 1920, height: 1080 },
    });

    expect(transforms).toEqual([
      expect.objectContaining({
        type: "position",
        parameters: {
          x: -480,
          y: -270,
        },
      }),
      expect.objectContaining({
        type: "scale",
        parameters: {
          x: 0.25,
          y: 0.25,
          isLinked: true,
        },
      }),
    ]);
  });

  it("returns no transforms when no crop-derived placement exists", () => {
    const asset = createAsset({
      creationMetadata: {
        source: "generated",
        workflowName: "Full Frame Workflow",
        inputs: [],
        maskCropMetadata: {
          mode: "full",
        },
      },
    });

    expect(deriveClipTransformsFromAsset(asset)).toEqual([]);
  });

  it("injects metadata-derived transforms into new clips", () => {
    const asset = createAsset({
      creationMetadata: {
        source: "generated",
        workflowName: "Clip Factory Workflow",
        inputs: [],
        maskCropMetadata: {
          mode: "cropped",
          crop_position: [240, 135],
          scale: 0.25,
        },
      },
    });

    const clip = createClipFromAsset(asset);

    expect(clip.transformations).toEqual([
      expect.objectContaining({
        type: "position",
        parameters: {
          x: -480,
          y: -270,
        },
      }),
      expect.objectContaining({
        type: "scale",
        parameters: {
          x: 0.25,
          y: 0.25,
          isLinked: true,
        },
      }),
    ]);
  });

  it("uses stored audio duration instead of the image fallback", () => {
    const clip = createClipFromAsset(
      createAsset({
        type: "audio",
        name: "song.mp3",
        duration: 42.75,
      }),
    );

    expect(clip.sourceDuration).toBe(42.75 * TICKS_PER_SECOND);
    expect(clip.timelineDuration).toBe(42.75 * TICKS_PER_SECOND);
  });

  it("keeps the 5 second fallback for images only", () => {
    const imageClip = createClipFromAsset(
      createAsset({
        type: "image",
        name: "poster.png",
        duration: undefined,
      }),
    );

    const audioClip = createClipFromAsset(
      createAsset({
        type: "audio",
        name: "broken-audio.mp3",
        duration: undefined,
      }),
    );

    expect(imageClip.timelineDuration).toBe(5 * TICKS_PER_SECOND);
    expect(audioClip.timelineDuration).toBe(0);
  });
});
