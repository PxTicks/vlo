import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { useTimelineStore } from "../../../../timeline";
import { useMaskViewStore } from "../../../../masks/store/useMaskViewStore";
import { useCanvasSelectionStore } from "../../../useCanvasSelectionStore";
import {
  type CanvasSelectableDisplayObject,
  resolveCanvasSelectableCandidates,
  useCanvasSelectionManager,
} from "../useCanvasSelectionManager";

function createDisplayObject(
  containsPoint: (point: { x: number; y: number }) => boolean,
): CanvasSelectableDisplayObject {
  return {
    destroyed: false,
    visible: true,
    containsPoint,
    getBounds: () => ({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    }),
  };
}

describe("useCanvasSelectionManager", () => {
  beforeEach(() => {
    useCanvasSelectionStore.getState().clearSelection();
    useTimelineStore.setState({
      selectedClipIds: [],
    });
    useMaskViewStore.setState({
      selectedMaskByClipId: {},
      isMaskTabActive: false,
    });
  });

  it("prefers the highest z-order candidate and breaks ties in favor of masks", () => {
    const candidates = resolveCanvasSelectableCandidates(
      [
        {
          id: "clip:low",
          kind: "clip" as const,
          displayObject: createDisplayObject(() => true),
          getClipId: () => "clip-low",
          getSelectionOrder: () => 1,
          onPointerDown: () => true,
        },
        {
          id: "clip:high",
          kind: "clip" as const,
          displayObject: createDisplayObject(() => true),
          getClipId: () => "clip-high",
          getSelectionOrder: () => 3,
          onPointerDown: () => true,
        },
        {
          id: "mask:high",
          kind: "mask" as const,
          displayObject: createDisplayObject(() => true),
          getClipId: () => "clip-high",
          getSelectionOrder: () => 3,
          onPointerDown: () => true,
        },
      ],
      { x: 10, y: 10 },
    );

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "mask:high",
      "clip:high",
      "clip:low",
    ]);
  });

  it("keeps the selection on the clip while mask editing is inactive", () => {
    // A clip that merely remembers a mask must still surface its own transform
    // gizmo (and be the Delete target) until the user opens the mask tab.
    useTimelineStore.setState({
      selectedClipIds: ["clip-1"],
    });
    useMaskViewStore.setState({
      selectedMaskByClipId: { "clip-1": "mask-a" },
      isMaskTabActive: false,
    });

    renderHook(() => useCanvasSelectionManager(null));

    expect(useCanvasSelectionStore.getState().activeSelection).toEqual({
      kind: "clip",
      clipId: "clip-1",
    });

    act(() => {
      useMaskViewStore.getState().setMaskTabActive(true);
    });

    expect(useCanvasSelectionStore.getState().activeSelection).toEqual({
      kind: "mask",
      clipId: "clip-1",
      maskId: "mask-a",
    });
  });

  it("syncs the active canvas selection with clip and mask selection changes", () => {
    useTimelineStore.setState({
      selectedClipIds: ["clip-1"],
    });
    useMaskViewStore.setState({
      selectedMaskByClipId: { "clip-1": "mask-a" },
      isMaskTabActive: true,
    });

    renderHook(() => useCanvasSelectionManager(null));

    expect(useCanvasSelectionStore.getState().activeSelection).toEqual({
      kind: "mask",
      clipId: "clip-1",
      maskId: "mask-a",
    });

    act(() => {
      useCanvasSelectionStore.getState().selectClip("clip-1");
    });

    expect(useCanvasSelectionStore.getState().activeSelection).toEqual({
      kind: "clip",
      clipId: "clip-1",
    });

    act(() => {
      useMaskViewStore.getState().setSelectedMask("clip-1", "mask-b");
    });

    expect(useCanvasSelectionStore.getState().activeSelection).toEqual({
      kind: "mask",
      clipId: "clip-1",
      maskId: "mask-b",
    });

    act(() => {
      useMaskViewStore.getState().setSelectedMask("clip-1", null);
    });

    expect(useCanvasSelectionStore.getState().activeSelection).toEqual({
      kind: "clip",
      clipId: "clip-1",
    });
  });
});
