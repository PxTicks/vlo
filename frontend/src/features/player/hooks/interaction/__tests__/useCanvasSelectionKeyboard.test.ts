import { fireEvent, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  MaskTimelineClip,
  TimelineClip,
} from "../../../../../types/TimelineTypes";
import { TICKS_PER_SECOND, useTimelineStore } from "../../../../timeline";
import { createMaskLayoutTransforms } from "../../../../masks/model/maskFactory";
import { useMaskViewStore } from "../../../../masks/store/useMaskViewStore";
import { useAssetBrowserSelectionStore } from "../../../../userAssets";
import { useCanvasSelectionStore } from "../../../useCanvasSelectionStore";
import { useCanvasSelectionKeyboard } from "../useCanvasSelectionKeyboard";

function createParentClip(trackId: string): TimelineClip {
  const duration = TICKS_PER_SECOND;
  return {
    id: "clip_mask_parent",
    trackId,
    type: "video",
    name: "Clip",
    assetId: "asset_1",
    sourceDuration: duration,
    start: 0,
    timelineDuration: duration,
    offset: 0,
    transformedDuration: duration,
    transformedOffset: 0,
    croppedSourceDuration: duration,
    transformations: [],
    components: [],
  };
}

function createMaskClip(
  parent: TimelineClip,
  localId: string,
): MaskTimelineClip {
  const id = `${parent.id}::mask::${localId}`;
  if (parent.type !== "mask") {
    parent.components = [
      ...(parent.components ?? []),
      {
        id: `mask_ref_${localId}`,
        type: "mask_ref",
        parameters: { maskClipId: id },
      },
    ];
  }

  return {
    id,
    trackId: parent.trackId,
    type: "mask",
    name: `Mask ${localId}`,
    sourceDuration: parent.sourceDuration,
    start: parent.start,
    timelineDuration: parent.timelineDuration,
    offset: parent.offset,
    transformedDuration: parent.transformedDuration,
    transformedOffset: parent.transformedOffset,
    croppedSourceDuration: parent.croppedSourceDuration,
    transformations: createMaskLayoutTransforms(id, {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
    }),
    parentClipId: parent.id,
    maskType: "rectangle",
    maskMode: "apply",
    maskInverted: false,
    maskParameters: {
      baseWidth: 120,
      baseHeight: 120,
    },
  };
}

describe("useCanvasSelectionKeyboard", () => {
  beforeEach(() => {
    useCanvasSelectionStore.getState().clearSelection();
    useMaskViewStore.setState({
      selectedMaskByClipId: {},
      pendingDrawRequest: null,
      interactionContext: null,
    });
    useAssetBrowserSelectionStore.setState({ selectedAssetIds: [] });
    useTimelineStore.setState({
      clips: [],
      selectedClipIds: [],
    });
  });

  it("deletes the active mask selection and selects the next mask", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const firstMask = createMaskClip(parent, "mask_a");
    const secondMask = createMaskClip(parent, "mask_b");

    useTimelineStore.setState({
      clips: [parent, firstMask, secondMask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_a");
    useCanvasSelectionStore.getState().selectMask(parent.id, "mask_a");

    renderHook(() => useCanvasSelectionKeyboard());

    fireEvent.keyDown(window, { key: "Delete" });

    const clips = useTimelineStore.getState().clips;
    expect(clips.some((clip) => clip.id === firstMask.id)).toBe(false);
    expect(clips.some((clip) => clip.id === secondMask.id)).toBe(true);
    expect(
      useMaskViewStore.getState().selectedMaskByClipId[parent.id],
    ).toBe("mask_b");
    expect(useCanvasSelectionStore.getState().activeSelection).toEqual({
      kind: "mask",
      clipId: parent.id,
      maskId: "mask_b",
    });
  });

  it("deletes the active clip sprite selection", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);

    useTimelineStore.setState({
      clips: [parent],
      selectedClipIds: [parent.id],
    });
    useCanvasSelectionStore.getState().selectClip(parent.id);

    renderHook(() => useCanvasSelectionKeyboard());

    fireEvent.keyDown(window, { key: "Delete" });

    expect(useTimelineStore.getState().clips).toEqual([]);
    expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
    expect(useCanvasSelectionStore.getState().activeSelection).toBeNull();
  });
});
