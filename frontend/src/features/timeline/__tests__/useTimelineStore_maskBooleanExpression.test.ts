import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  MaskBooleanExpression,
  MaskTimelineClip,
  StandardTimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import type { MaskCompositionComponent } from "../../../types/Components";

function getParentCompositionExpression(
  clip: StandardTimelineClip | undefined,
): MaskBooleanExpression | null | undefined {
  const composition = (clip?.components ?? []).find(
    (component): component is MaskCompositionComponent =>
      component.type === "mask_composition",
  );
  return composition?.parameters.expression;
}

import { createMask } from "../../masks/model/maskFactory";
import {
  selectMaskClipsForParent,
  selectResolvedMaskBooleanExpressionForParent,
  useTimelineStore,
} from "../useTimelineStore";

function createTrack(id: string, label: string): TimelineTrack {
  return {
    id,
    label,
    isVisible: true,
    isLocked: false,
    isMuted: false,
    type: "visual",
  };
}

function createMaskClip(
  parentClipId: string,
  localId: string,
  trackId: string,
  overrides: Partial<MaskTimelineClip> = {},
): MaskTimelineClip {
  return {
    id: `${parentClipId}::mask::${localId}`,
    trackId,
    type: "mask",
    name: `Mask ${localId}`,
    sourceDuration: 120,
    start: 0,
    timelineDuration: 120,
    offset: 0,
    transformedDuration: 120,
    transformedOffset: 0,
    croppedSourceDuration: 120,
    transformations: [],
    parentClipId,
    maskType: "rectangle",
    maskMode: "apply",
    maskInverted: false,
    maskParameters: {
      baseWidth: 100,
      baseHeight: 100,
    },
    ...overrides,
  };
}

function createParentClip(
  id: string,
  trackId: string,
  maskLocalIds: string[],
  options: {
    maskBooleanExpression?: MaskBooleanExpression | null;
    overrides?: Partial<StandardTimelineClip>;
  } = {},
): StandardTimelineClip {
  const maskRefs = maskLocalIds.map((maskLocalId, index) => ({
    id: `mask_ref_${id}_${index}`,
    type: "mask_ref" as const,
    parameters: {
      maskClipId: `${id}::mask::${maskLocalId}`,
    },
  }));

  const compositionComponent: MaskCompositionComponent | null =
    options.maskBooleanExpression !== undefined
      ? {
          id: `mask_composition_${id}`,
          type: "mask_composition",
          parameters: {
            expression: options.maskBooleanExpression,
            compositeTransformations: [],
          },
        }
      : null;

  return {
    id,
    trackId,
    type: "video",
    name: id,
    assetId: `${id}-asset`,
    sourceDuration: 120,
    start: 0,
    timelineDuration: 120,
    offset: 0,
    transformedDuration: 120,
    transformedOffset: 0,
    croppedSourceDuration: 120,
    transformations: [],
    components: compositionComponent ? [...maskRefs, compositionComponent] : maskRefs,
    ...options.overrides,
  };
}

describe("useTimelineStore mask boolean expressions", () => {
  beforeEach(() => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        createTrack("track_top_pad", "Track 1"),
        createTrack("track_current", "Track 2"),
        createTrack("track_bottom_pad", "Track 3"),
      ],
      clips: [],
    });
  });

  it("preserves clipComponents order when selecting child masks", () => {
    const parent = createParentClip("clip_1", "track_current", [
      "mask_2",
      "mask_1",
    ]);
    const mask1 = createMaskClip("clip_1", "mask_1", "track_current");
    const mask2 = createMaskClip("clip_1", "mask_2", "track_current");

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: useTimelineStore.getState().tracks,
      clips: [parent, mask1, mask2],
    });

    const orderedMasks = selectMaskClipsForParent(
      useTimelineStore.getState(),
      parent.id,
    );
    expect(orderedMasks.map((mask) => mask.id)).toEqual([mask2.id, mask1.id]);
  });

  it("resolves legacy expressions when no explicit AST is stored and honors null explicitly", () => {
    const legacyParent = createParentClip("clip_legacy", "track_current", [
      "mask_1",
      "mask_2",
    ]);
    const explicitNullParent = createParentClip(
      "clip_none",
      "track_current",
      ["mask_3"],
      {
        maskBooleanExpression: null,
      },
    );

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: useTimelineStore.getState().tracks,
      clips: [
        legacyParent,
        createMaskClip("clip_legacy", "mask_1", "track_current"),
        createMaskClip("clip_legacy", "mask_2", "track_current", {
          maskInverted: true,
        }),
        explicitNullParent,
        createMaskClip("clip_none", "mask_3", "track_current"),
      ],
    });

    expect(
      selectResolvedMaskBooleanExpressionForParent(
        useTimelineStore.getState(),
        legacyParent.id,
      ),
    ).toEqual({
      kind: "operation",
      operator: "intersect",
      left: {
        kind: "mask_ref",
        maskId: "mask_1",
      },
      right: {
        kind: "mask_ref",
        maskId: "mask_2",
      },
    } satisfies MaskBooleanExpression);
    expect(
      selectResolvedMaskBooleanExpressionForParent(
        useTimelineStore.getState(),
        explicitNullParent.id,
      ),
    ).toBeNull();
  });

  it("prunes and collapses stored expressions when a child mask is removed", () => {
    const parent = createParentClip("clip_1", "track_current", [
      "mask_1",
      "mask_2",
    ], {
      maskBooleanExpression: {
        kind: "operation",
        operator: "subtract",
        left: { kind: "mask_ref", maskId: "mask_1" },
        right: { kind: "mask_ref", maskId: "mask_2" },
      },
    });

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: useTimelineStore.getState().tracks,
      clips: [
        parent,
        createMaskClip("clip_1", "mask_1", "track_current"),
        createMaskClip("clip_1", "mask_2", "track_current"),
      ],
    });

    act(() => {
      useTimelineStore.getState().removeClipMask("clip_1", "mask_2");
    });

    const updatedParent = useTimelineStore
      .getState()
      .clips.find(
        (clip): clip is StandardTimelineClip =>
          clip.id === "clip_1" && clip.type !== "mask",
      );
    expect(getParentCompositionExpression(updatedParent)).toEqual({
      kind: "mask_ref",
      maskId: "mask_1",
    });
  });

  it("preserves local mask ids in stored expressions when copying and pasting a parent clip", () => {
    const parent = createParentClip("clip_1", "track_current", [
      "mask_1",
      "mask_2",
    ], {
      maskBooleanExpression: {
        kind: "operation",
        operator: "union",
        left: { kind: "mask_ref", maskId: "mask_1" },
        right: { kind: "mask_ref", maskId: "mask_2" },
      },
    });

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: useTimelineStore.getState().tracks,
      clips: [
        parent,
        createMaskClip("clip_1", "mask_1", "track_current"),
        createMaskClip("clip_1", "mask_2", "track_current"),
      ],
    });
    useTimelineStore.setState({
      selectedClipIds: [parent.id],
    });

    act(() => {
      expect(useTimelineStore.getState().copySelectedClip()).toBe(true);
      expect(useTimelineStore.getState().pasteCopiedClipAbove()).toBe(true);
    });

    const parentClips = useTimelineStore
      .getState()
      .clips.filter(
        (clip): clip is StandardTimelineClip => clip.type !== "mask",
      );
    expect(parentClips).toHaveLength(2);

    const pastedParent = parentClips.find((clip) => clip.id !== parent.id);
    expect(getParentCompositionExpression(pastedParent)).toEqual(
      getParentCompositionExpression(parent),
    );
    expect(
      (pastedParent?.components ?? [])
        .filter((component) => component.type === "mask_ref")
        .map((component) =>
          component.type === "mask_ref" ? component.parameters.maskClipId : null,
        ),
    ).toEqual([
      `${pastedParent?.id}::mask::mask_1`,
      `${pastedParent?.id}::mask::mask_2`,
    ]);
  });

  it("automatically appends a newly added mask to the end of the equation as a union", () => {
    const parent = createParentClip("clip_1", "track_current", ["mask_1"]);
    const mask1 = createMaskClip("clip_1", "mask_1", "track_current");

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: useTimelineStore.getState().tracks,
      clips: [parent, mask1],
    });

    act(() => {
      useTimelineStore.getState().addClipMask(
        parent.id,
        createMask("triangle", {
          id: "mask_2",
          inverted: false,
          parameters: {
            baseWidth: 120,
            baseHeight: 120,
          },
        }),
      );
    });

    const updatedParent = useTimelineStore
      .getState()
      .clips.find(
        (clip): clip is StandardTimelineClip =>
          clip.id === parent.id && clip.type !== "mask",
      );

    expect(getParentCompositionExpression(updatedParent)).toEqual({
      kind: "operation",
      operator: "union",
      left: {
        kind: "mask_ref",
        maskId: "mask_1",
      },
      right: {
        kind: "mask_ref",
        maskId: "mask_2",
      },
    });
  });
});
