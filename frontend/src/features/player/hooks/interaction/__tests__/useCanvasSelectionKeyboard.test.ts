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
import { useEditorFocusStore } from "../../../../../app/focus/useEditorFocusStore";
import { useCanvasSelectionKeyboard } from "../useCanvasSelectionKeyboard";

function createParentClip(
  trackId: string,
  id: string = "clip_mask_parent",
): TimelineClip {
  const duration = TICKS_PER_SECOND;
  return {
    id,
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
    // Default to the canvas owning the keyboard; region-gated behaviour is
    // exercised explicitly below.
    useEditorFocusStore.getState().setRegion("canvas");
    useTimelineStore.setState({
      clips: [],
      selectedClipIds: [],
    });
  });

  it("deletes the active mask and falls back to the clip transform gizmo", () => {
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
    // The sibling mask is untouched: deleting one mask does NOT walk to the
    // next, which is what used to cascade a held Delete through every mask.
    expect(clips.some((clip) => clip.id === secondMask.id)).toBe(true);
    expect(
      useMaskViewStore.getState().selectedMaskByClipId[parent.id],
    ).toBeUndefined();
    expect(useCanvasSelectionStore.getState().activeSelection).toEqual({
      kind: "clip",
      clipId: parent.id,
    });
  });

  it("does nothing when the canvas does not own the keyboard", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);

    useTimelineStore.setState({
      clips: [parent],
      selectedClipIds: [parent.id],
    });
    useCanvasSelectionStore.getState().selectClip(parent.id);
    useEditorFocusStore.getState().setRegion("timeline");

    renderHook(() => useCanvasSelectionKeyboard());

    fireEvent.keyDown(window, { key: "Delete" });

    expect(useTimelineStore.getState().clips).toHaveLength(1);
    expect(useCanvasSelectionStore.getState().activeSelection).toEqual({
      kind: "clip",
      clipId: parent.id,
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

  it("deletes all selected clips when the active sprite is multiselected", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const primary = createParentClip(trackId, "clip-primary");
    const secondary = createParentClip(trackId, "clip-secondary");

    useTimelineStore.setState({
      clips: [primary, secondary],
      selectedClipIds: [primary.id, secondary.id],
    });
    useCanvasSelectionStore.getState().selectClip(primary.id);

    renderHook(() => useCanvasSelectionKeyboard());

    fireEvent.keyDown(window, { key: "Delete" });

    expect(useTimelineStore.getState().clips).toEqual([]);
    expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
    expect(useCanvasSelectionStore.getState().activeSelection).toBeNull();
  });

  it("ignores delete presses coming from the mask equation editor", () => {
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

    const equationRoot = document.createElement("div");
    equationRoot.setAttribute("data-mask-equation-editor", "true");
    const equationChip = document.createElement("button");
    equationRoot.appendChild(equationChip);
    document.body.appendChild(equationRoot);

    try {
      fireEvent.keyDown(equationChip, { key: "Delete" });
    } finally {
      document.body.removeChild(equationRoot);
    }

    const clips = useTimelineStore.getState().clips;
    expect(clips.some((clip) => clip.id === firstMask.id)).toBe(true);
    expect(clips.some((clip) => clip.id === secondMask.id)).toBe(true);
    expect(
      useMaskViewStore.getState().selectedMaskByClipId[parent.id],
    ).toBe("mask_a");
    expect(useCanvasSelectionStore.getState().activeSelection).toEqual({
      kind: "mask",
      clipId: parent.id,
      maskId: "mask_a",
    });
  });
});
