import { beforeEach, describe, expect, it } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type { BaseClip, TimelineTrack } from "../../../../types/TimelineTypes";
import type { StandardTimelineClip } from "../../../../types/TimelineTypes";
import type { MaskCompositionComponent } from "../../../../types/Components";
import { useTimelineStore } from "../../useTimelineStore";
import { attachGenerationMaskToDraft } from "../../model/timelineCommands";
import { getOrderedChildMaskClips } from "../../model/maskClipModel";
import { resolveMaskBooleanExpression } from "../../../masks/model/maskBooleanExpression";
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
  } as BaseClip;
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

  it("grows the generated mask under the feather by the asset's recorded grow", () => {
    const asset: Asset = {
      id: "generated_asset",
      hash: "hash-generated",
      name: "generated.mp4",
      type: "video",
      src: "blob:generated",
      createdAt: 0,
      creationMetadata: {
        source: "generated",
        workflowName: "SeamPass",
        inputs: [],
        generationMaskAssetId: "generation-mask-asset",
        generationMaskGrow: 48,
      },
    };

    attachGenerationMask("clip_1", asset);

    const parentClip = useTimelineStore
      .getState()
      .clips.find(
        (clip): clip is StandardTimelineClip =>
          clip.id === "clip_1" && clip.type !== "mask",
      );
    const expected = [
      expect.objectContaining({
        type: "mask_grow",
        isEnabled: true,
        parameters: { amount: 48, invert: false },
      }),
      expect.objectContaining({
        type: "feather",
        parameters: { mode: "hard_outer", amount: 30, invert: false },
      }),
    ];
    expect(getCompositeTransforms(parentClip)).toEqual(expected);

    // The extension placement path seeds the same edges.
    const draft = {
      tracks: [createTrack("track_1")],
      clips: [createParentClip()],
    } as unknown as Parameters<typeof attachGenerationMaskToDraft>[0];
    attachGenerationMaskToDraft(draft, "clip_1", "generation-mask-asset", {
      growPx: 48,
    });
    const draftParent = draft.clips.find(
      (clip): clip is StandardTimelineClip =>
        clip.id === "clip_1" && clip.type !== "mask",
    );
    expect(getCompositeTransforms(draftParent)).toEqual(expected);
  });

  it("attaches generated masks switched off for disabled placement", () => {
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

    attachGenerationMask("clip_1", asset, { metadataPlacement: "disabled" });

    const { clips } = useTimelineStore.getState();
    const parentClip = clips.find(
      (clip): clip is StandardTimelineClip =>
        clip.id === "clip_1" && clip.type !== "mask",
    );
    const maskClips = getOrderedChildMaskClips(clips, parentClip!);
    const composition = (parentClip?.components ?? []).find(
      (component): component is MaskCompositionComponent =>
        component.type === "mask_composition",
    );

    // The mask and its feathering stay attached; only the equation is off.
    expect(maskClips).toHaveLength(1);
    expect(maskClips[0].generationMaskAssetId).toBe("generation-mask-asset");
    expect(getCompositeTransforms(parentClip)).toHaveLength(1);
    expect(composition?.parameters.expressionEnabled).toBe(false);
    expect(resolveMaskBooleanExpression(parentClip!, maskClips)).toBeNull();

    useTimelineStore.getState().setClipMaskExpressionEnabled("clip_1", true);
    const reenabledParent = useTimelineStore
      .getState()
      .clips.find(
        (clip): clip is StandardTimelineClip =>
          clip.id === "clip_1" && clip.type !== "mask",
      );
    expect(
      resolveMaskBooleanExpression(reenabledParent!, maskClips),
    ).not.toBeNull();
  });

  it.each([
    ["applied", undefined],
    ["disabled", false],
  ] as const)(
    "keeps the draft mask attach in step with the store path (%s)",
    (metadataPlacement, expectedExpressionEnabled) => {
      const draft = {
        tracks: [createTrack("track_1")],
        clips: [createParentClip()],
      } as unknown as Parameters<typeof attachGenerationMaskToDraft>[0];

      attachGenerationMaskToDraft(draft, "clip_1", "generation-mask-asset", {
        enabled: metadataPlacement === "applied",
      });

      const parent = draft.clips.find(
        (clip): clip is StandardTimelineClip =>
          clip.id === "clip_1" && clip.type !== "mask",
      );
      const composition = (parent?.components ?? []).find(
        (component): component is MaskCompositionComponent =>
          component.type === "mask_composition",
      );
      expect(composition?.parameters.expressionEnabled).toBe(
        expectedExpressionEnabled,
      );
    },
  );

  it("places new clips on the bottom-most compatible track when nothing is occupied in range", () => {
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

    expect(insertedClip?.trackId).toBe("track_bottom");
  });

  it("places new clips on the track directly above the topmost occupied track in range", () => {
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
          trackId: "track_middle",
          start: 0,
        },
      ],
    });

    const clipId = insertBaseClipAtTime(createBaseClip(), 0);
    const insertedClip = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === clipId);

    expect(insertedClip?.trackId).toBe("track_top");
  });

  it("places new clips on the track directly above the topmost occupied track, skipping incompatible tracks", () => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        createTrack("track_top"),
        createTrack("track_audio", "audio"),
        createTrack("track_middle"),
        createTrack("track_bottom"),
      ],
      clips: [
        {
          ...createParentClip(),
          id: "clip_existing",
          trackId: "track_bottom",
          start: 0,
        },
      ],
    });

    const clipId = insertBaseClipAtTime(createBaseClip(), 0);
    const insertedClip = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === clipId);

    expect(insertedClip?.trackId).toBe("track_middle");
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
