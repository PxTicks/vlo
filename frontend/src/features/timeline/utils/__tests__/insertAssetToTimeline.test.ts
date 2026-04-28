import { beforeEach, describe, expect, it } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type { StandardTimelineClip } from "../../../../types/TimelineTypes";
import type { MaskCompositionComponent } from "../../../../types/Components";
import { useTimelineStore } from "../../useTimelineStore";
import { attachGenerationMask } from "../insertAssetToTimeline";

function getCompositeTransforms(clip: StandardTimelineClip | undefined) {
  const composition = (clip?.components ?? []).find(
    (component): component is MaskCompositionComponent =>
      component.type === "mask_composition",
  );
  return composition?.parameters.compositeTransformations ?? [];
}

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

  it("attaches generated masks and seeds shared hard outer feathering", () => {
    const asset: Asset = {
      id: "generated_asset",
      hash: "hash-generated",
      name: "generated.mp4",
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

    const parentClip = useTimelineStore
      .getState()
      .clips.find(
        (clip): clip is StandardTimelineClip =>
          clip.id === "clip_1" && clip.type !== "mask",
      );

    expect(maskClip?.type).toBe("mask");
    expect(maskClip?.generationMaskAssetId).toBe("generation-mask-asset");
    expect(maskClip?.transformations).toEqual([]);
    expect(getCompositeTransforms(parentClip)).toEqual([
      expect.objectContaining({
        type: "feather",
        isEnabled: true,
        parameters: {
          mode: "hard_outer",
          amount: 30,
          invert: false,
        },
      }),
    ]);
  });
});
