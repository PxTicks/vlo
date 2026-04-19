import { beforeEach, describe, expect, it } from "vitest";
import type {
  MaskTimelineClip,
  StandardTimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import type { MaskCompositionComponent } from "../../../types/Components";
import { useTimelineStore } from "../useTimelineStore";

function getCompositeTransforms(
  clip: StandardTimelineClip | undefined,
) {
  const composition = (clip?.components ?? []).find(
    (component): component is MaskCompositionComponent =>
      component.type === "mask_composition",
  );
  return composition?.parameters.compositeTransformations ?? [];
}

const createTrack = (id: string): TimelineTrack => ({
  id,
  label: id,
  isVisible: true,
  isLocked: false,
  isMuted: false,
  type: "visual",
});

function createParentClip(maskClipId: string): StandardTimelineClip {
  return {
    id: "clip_1",
    trackId: "track_1",
    type: "video",
    name: "Parent clip",
    assetId: "asset_1",
    sourceDuration: 120,
    start: 0,
    timelineDuration: 120,
    offset: 0,
    transformedDuration: 120,
    transformedOffset: 0,
    croppedSourceDuration: 120,
    transformations: [],
    components: [
      {
        id: "mask_ref_1",
        type: "mask_ref",
        parameters: { maskClipId },
      },
    ],
  };
}

function createLegacyMaskClip(): MaskTimelineClip {
  return {
    id: "clip_1::mask::mask_1",
    trackId: "track_1",
    type: "mask",
    name: "Legacy mask",
    sourceDuration: 120,
    start: 0,
    timelineDuration: 120,
    offset: 0,
    transformedDuration: 120,
    transformedOffset: 0,
    croppedSourceDuration: 120,
    parentClipId: "clip_1",
    maskType: "rectangle",
    maskMode: "apply",
    maskInverted: false,
    maskParameters: {
      baseWidth: 100,
      baseHeight: 100,
    },
    transformations: [
      {
        id: "grow_1",
        type: "mask_grow",
        isEnabled: true,
        parameters: {
          amount: 18,
        },
      },
      {
        id: "feather_1",
        type: "feather",
        isEnabled: true,
        parameters: {
          mode: "hard_outer",
          amount: 24,
        },
      },
    ],
  };
}

describe("useTimelineStore shared mask composite transforms", () => {
  beforeEach(() => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [createTrack("track_1")],
      clips: [],
    });
  });

  it("migrates legacy per-mask edge transforms onto the parent clip", () => {
    const legacyMask = createLegacyMaskClip();

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [createTrack("track_1")],
      clips: [createParentClip(legacyMask.id), legacyMask],
    });

    const state = useTimelineStore.getState();
    const parentClip = state.clips.find(
      (clip): clip is StandardTimelineClip =>
        clip.id === "clip_1" && clip.type !== "mask",
    );
    const maskClip = state.clips.find(
      (clip): clip is MaskTimelineClip =>
        clip.id === legacyMask.id && clip.type === "mask",
    );

    expect(getCompositeTransforms(parentClip)).toEqual([
      expect.objectContaining({
        type: "mask_grow",
        parameters: {
          amount: 18,
        },
      }),
      expect.objectContaining({
        type: "feather",
        parameters: {
          mode: "hard_outer",
          amount: 24,
        },
      }),
    ]);
    expect(
      maskClip?.transformations.some(
        (transform) =>
          transform.type === "mask_grow" || transform.type === "feather",
      ),
    ).toBe(false);
  });

  it("auto-syncs shared edge inversion when a mask inversion changes", () => {
    const legacyMask = createLegacyMaskClip();

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [createTrack("track_1")],
      clips: [createParentClip(legacyMask.id), legacyMask],
    });

    useTimelineStore
      .getState()
      .updateClipMask("clip_1", "mask_1", { maskInverted: true });

    let parentClip = useTimelineStore.getState().clips.find(
      (clip): clip is StandardTimelineClip =>
        clip.id === "clip_1" && clip.type !== "mask",
    );

    expect(getCompositeTransforms(parentClip)).toEqual([
      expect.objectContaining({
        type: "mask_grow",
        parameters: expect.objectContaining({
          amount: 18,
          invert: true,
        }),
      }),
      expect.objectContaining({
        type: "feather",
        parameters: expect.objectContaining({
          mode: "hard_outer",
          amount: 24,
          invert: true,
        }),
      }),
    ]);

    useTimelineStore
      .getState()
      .updateClipMask("clip_1", "mask_1", { maskInverted: false });

    parentClip = useTimelineStore.getState().clips.find(
      (clip): clip is StandardTimelineClip =>
        clip.id === "clip_1" && clip.type !== "mask",
    );

    expect(getCompositeTransforms(parentClip)).toEqual([
      expect.objectContaining({
        type: "mask_grow",
        parameters: expect.objectContaining({
          amount: 18,
          invert: false,
        }),
      }),
      expect.objectContaining({
        type: "feather",
        parameters: expect.objectContaining({
          mode: "hard_outer",
          amount: 24,
          invert: false,
        }),
      }),
    ]);
  });
});
