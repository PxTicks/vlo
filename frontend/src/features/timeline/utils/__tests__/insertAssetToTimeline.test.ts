import { beforeEach, describe, expect, it } from "vitest";
import type { Asset } from "../../../../types/Asset";
import { useTimelineStore } from "../../useTimelineStore";
import { attachGenerationMask } from "../insertAssetToTimeline";

function createParentClip() {
  return {
    id: "clip_1",
    trackId: "track_1",
    type: "video" as const,
    name: "Generated Clip",
    assetId: "asset_1",
    sourceDuration: 120,
    start: 0,
    timelineDuration: 120,
    offset: 0,
    transformedDuration: 120,
    transformedOffset: 0,
    croppedSourceDuration: 120,
    transformations: [],
  };
}

describe("insertAssetToTimeline", () => {
  beforeEach(() => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        {
          id: "track_1",
          label: "Track 1",
          isVisible: true,
          isMuted: false,
          isLocked: false,
          type: "visual",
        },
      ],
      clips: [createParentClip()],
    });
  });

  it("attaches generated masks with default hard outer feathering", () => {
    const asset: Asset = {
      id: "generated_asset",
      hash: "hash-generated",
      name: "generated.webm",
      type: "video",
      src: "blob:generated",
      createdAt: 0,
      creationMetadata: {
        source: "generated",
        workflowName: "MaskLoadTest",
        inputs: [],
        generationMaskAssetId: "generation-mask-asset",
      },
    };

    attachGenerationMask("clip_1", asset);

    const maskClip = useTimelineStore
      .getState()
      .clips.find((clip) => clip.type === "mask");

    expect(maskClip?.type).toBe("mask");
    expect(maskClip?.generationMaskAssetId).toBe("generation-mask-asset");
    expect(maskClip?.transformations).toEqual([
      expect.objectContaining({
        type: "feather",
        isEnabled: true,
        parameters: {
          mode: "hard_outer",
          amount: 30,
        },
      }),
    ]);
  });
});
