import { beforeEach, describe, expect, it } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type { BaseClip, TimelineTrack } from "../../../../types/TimelineTypes";
import type { StandardTimelineClip } from "../../../../types/TimelineTypes";
import type { MaskCompositionComponent } from "../../../../types/Components";
import { useTimelineStore } from "../../useTimelineStore";
import {
  attachGenerationMask,
  insertBaseClipAtTime,
} from "../insertAssetToTimeline";

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

function createTrack(
  id: string,
  type: TimelineTrack["type"] = "visual",
): TimelineTrack {
  return {
    id,
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
    type,
  };
}

function createBaseClip(
  overrides: Partial<BaseClip> = {},
): BaseClip {
  return {
    id: "clip_base",
    type: "image",
    name: "Inserted Clip",
    assetId: "asset_inserted",
    sourceDuration: null,
    timelineDuration: 120,
    croppedSourceDuration: 120,
    offset: 0,
    transformedDuration: 120,
    transformedOffset: 0,
    transformations: [],
    ...overrides,
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

  it("places new clips on the topmost compatible track that is free in range", () => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        createTrack("track_top"),
        createTrack("track_middle"),
        createTrack("track_bottom"),
      ],
      clips: [
        {
          ...createParentClip(),
          id: "clip_existing",
          trackId: "track_bottom",
          start: 500,
        },
      ],
    });

    const clipId = insertBaseClipAtTime(createBaseClip(), 0);
    const insertedClip = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === clipId);

    expect(insertedClip?.trackId).toBe("track_top");
  });

  it("inserts a new compatible track above the occupied stack when needed", () => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        createTrack("track_audio", "audio"),
        createTrack("track_visual_a"),
        createTrack("track_visual_b"),
      ],
      clips: [
        {
          ...createParentClip(),
          id: "clip_visual_a",
          trackId: "track_visual_a",
          start: 0,
        },
        {
          ...createParentClip(),
          id: "clip_visual_b",
          trackId: "track_visual_b",
          start: 0,
        },
      ],
    });

    const clipId = insertBaseClipAtTime(createBaseClip(), 0);
    const state = useTimelineStore.getState();
    const insertedClip = state.clips.find((clip) => clip.id === clipId);
    const insertedTrackIndex = state.tracks.findIndex(
      (track) => track.id === insertedClip?.trackId,
    );
    const firstVisualTrackIndex = state.tracks.findIndex(
      (track) => track.id === "track_visual_a",
    );

    expect(insertedClip?.trackId).toBeTruthy();
    expect(insertedClip?.trackId).not.toBe("track_visual_a");
    expect(insertedClip?.trackId).not.toBe("track_visual_b");
    expect(insertedTrackIndex).toBeGreaterThan(-1);
    expect(insertedTrackIndex).toBeLessThan(firstVisualTrackIndex);
  });
});
