import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BRUSH_RADIUS,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  useMaskViewStore,
} from "../useMaskViewStore";

function bitmap(): ImageBitmap {
  return { close: vi.fn() } as unknown as ImageBitmap;
}

describe("useMaskViewStore", () => {
  beforeEach(() => {
    useMaskViewStore.setState({
      selectedMaskByClipId: {},
      sam2EditorMaskByClipId: {},
      isMaskTabActive: false,
      pendingDrawRequest: null,
      interactionContext: null,
      sam2LivePreviewByClipId: {},
      sam2PointMode: "add",
      brushTool: "gizmo",
      brushRadius: DEFAULT_BRUSH_RADIUS,
      maskPreviewTarget: null,
    });
  });

  it("selects and clears regular and SAM2 editor masks", () => {
    const state = useMaskViewStore.getState();
    state.setSelectedMask("clip-1", "mask-1");
    state.setSam2EditorMask("clip-1", "mask-2");
    expect(useMaskViewStore.getState()).toMatchObject({
      selectedMaskByClipId: { "clip-1": "mask-1" },
      sam2EditorMaskByClipId: { "clip-1": "mask-2" },
    });
    state.setSelectedMask("clip-1", null);
    state.setSam2EditorMask("clip-1", null);
    expect(useMaskViewStore.getState()).toMatchObject({
      selectedMaskByClipId: {},
      sam2EditorMaskByClipId: {},
    });
  });

  it("manages draw and edit interaction state", () => {
    const state = useMaskViewStore.getState();
    state.setMaskTabActive(true);
    state.requestMaskDraw("clip-1", "rectangle");
    expect(useMaskViewStore.getState()).toMatchObject({
      isMaskTabActive: true,
      pendingDrawRequest: { clipId: "clip-1", shape: "rectangle" },
      interactionContext: {
        clipId: "clip-1",
        mode: "draw",
        maskId: null,
      },
    });
    state.clearPendingDraw();
    expect(useMaskViewStore.getState()).toMatchObject({
      pendingDrawRequest: null,
      interactionContext: null,
    });

    state.setInteractionContext({
      clipId: "clip-1",
      mode: "edit",
      maskId: "mask-1",
    });
    state.clearPendingDraw();
    expect(useMaskViewStore.getState().interactionContext).toMatchObject({
      mode: "edit",
    });
  });

  it("sets point mode, brush tool, and clamps brush radius", () => {
    const state = useMaskViewStore.getState();
    state.setSam2PointMode("remove");
    state.setBrushTool("paint");
    state.setBrushRadius(1.2);
    expect(useMaskViewStore.getState()).toMatchObject({
      sam2PointMode: "remove",
      brushTool: "paint",
      brushRadius: MIN_BRUSH_RADIUS,
    });
    state.setBrushRadius(999);
    expect(useMaskViewStore.getState().brushRadius).toBe(MAX_BRUSH_RADIUS);
    state.setBrushRadius(12.6);
    expect(useMaskViewStore.getState().brushRadius).toBe(13);
  });

  it("replaces and clears live previews while closing bitmaps", () => {
    const first = bitmap();
    const second = bitmap();
    const state = useMaskViewStore.getState();
    state.setSam2LivePreview(
      "clip-1",
      "mask-1",
      first,
      100,
      50,
      2,
      24,
      "hash-1",
    );
    state.setSam2LivePreview(
      "clip-1",
      "mask-2",
      second,
      200,
      100,
      3,
      30,
      "hash-2",
    );
    expect(first.close).toHaveBeenCalled();
    expect(useMaskViewStore.getState().sam2LivePreviewByClipId["clip-1"]).toEqual(
      {
        maskId: "mask-2",
        bitmap: second,
        width: 200,
        height: 100,
        frameIndex: 3,
        sourceFps: 30,
        pointsHash: "hash-2",
      },
    );
    state.clearSam2LivePreview("missing");
    state.clearSam2LivePreview("clip-1");
    expect(second.close).toHaveBeenCalled();
    expect(
      useMaskViewStore.getState().sam2LivePreviewByClipId["clip-1"],
    ).toBeUndefined();
  });

  it("sets preview targets idempotently and clears them", () => {
    const state = useMaskViewStore.getState();
    state.setMaskPreviewTarget("clip-1", "mask-1");
    const targetState = useMaskViewStore.getState();
    targetState.setMaskPreviewTarget("clip-1", "mask-1");
    expect(useMaskViewStore.getState()).toBe(targetState);
    state.clearMaskPreviewTarget();
    const clearedState = useMaskViewStore.getState();
    clearedState.clearMaskPreviewTarget();
    expect(useMaskViewStore.getState()).toBe(clearedState);
  });

  it("clears every clip-scoped field without disturbing other clips", () => {
    const preview = bitmap();
    useMaskViewStore.setState({
      selectedMaskByClipId: { one: "mask-1", two: "mask-2" },
      sam2EditorMaskByClipId: { one: "mask-1", two: "mask-2" },
      pendingDrawRequest: { clipId: "one", shape: "circle" },
      interactionContext: { clipId: "one", mode: "edit", maskId: "mask-1" },
      sam2LivePreviewByClipId: {
        one: {
          maskId: "mask-1",
          bitmap: preview,
          width: 1,
          height: 1,
          frameIndex: 0,
          sourceFps: 1,
          pointsHash: "hash",
        },
      },
      maskPreviewTarget: { clipId: "one", maskId: "mask-1" },
    });

    useMaskViewStore.getState().clearClipState("one");
    expect(preview.close).toHaveBeenCalled();
    expect(useMaskViewStore.getState()).toMatchObject({
      selectedMaskByClipId: { two: "mask-2" },
      sam2EditorMaskByClipId: { two: "mask-2" },
      pendingDrawRequest: null,
      interactionContext: null,
      sam2LivePreviewByClipId: {},
      maskPreviewTarget: null,
    });
  });

  it("preserves unrelated transient state when clearing another clip", () => {
    useMaskViewStore.setState({
      pendingDrawRequest: { clipId: "two", shape: "rectangle" },
      interactionContext: { clipId: "two", mode: "draw", maskId: null },
      maskPreviewTarget: { clipId: "two", maskId: "mask-2" },
    });
    useMaskViewStore.getState().clearClipState("one");
    expect(useMaskViewStore.getState()).toMatchObject({
      pendingDrawRequest: { clipId: "two" },
      interactionContext: { clipId: "two" },
      maskPreviewTarget: { clipId: "two" },
    });
  });
});
