import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeStatus } from "../../../../types/RuntimeStatus";
import type {
  MaskTimelineClip,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import { playbackClock } from "../../../player/services/PlaybackClock";
import { TICKS_PER_SECOND, useTimelineStore } from "../../../timeline";
import { useAssetStore } from "../../../userAssets";
import { useMaskViewStore } from "../../store/useMaskViewStore";
import {
  disposeBrushBuffer,
  ensureBrushBuffer,
  paintBrushDot,
} from "../../runtime/brushBufferRegistry";
import { useMaskPanel } from "../useMaskPanel";
import { getRuntimeStatus } from "../../../../services/runtimeApi";

vi.mock("../../../../services/runtimeApi", () => ({
  getRuntimeStatus: vi.fn(),
}));

vi.mock("../../services/sam2Api", () => ({
  clearSam2EditorSession: vi.fn(async () => undefined),
  generateMaskFrame: vi.fn(),
  generateMaskVideo: vi.fn(),
  initSam2EditorSession: vi.fn(async () => ({})),
  registerSourceVideo: vi.fn(),
}));

function createParentClip(id: string): TimelineClip {
  const duration = TICKS_PER_SECOND;
  return {
    id,
    trackId: useTimelineStore.getState().tracks[0].id,
    type: "video",
    name: `Clip ${id}`,
    assetId: `asset_${id}`,
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

function createSam2MaskClip(
  parent: TimelineClip,
  localId: string,
  maskMode: "apply" | "preview" = "preview",
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
    transformations: [],
    parentClipId: parent.id,
    maskType: "sam2",
    maskMode,
    maskInverted: false,
    maskParameters: {
      baseWidth: 1,
      baseHeight: 1,
    },
    maskPoints: [],
  };
}

function createBrushMaskClip(
  parent: TimelineClip,
  localId: string,
  maskMode: "apply" | "preview" = "apply",
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
    name: `Brush ${localId}`,
    sourceDuration: parent.sourceDuration,
    start: parent.start,
    timelineDuration: parent.timelineDuration,
    offset: parent.offset,
    transformedDuration: parent.transformedDuration,
    transformedOffset: parent.transformedOffset,
    croppedSourceDuration: parent.croppedSourceDuration,
    transformations: [],
    parentClipId: parent.id,
    maskType: "brush",
    maskMode,
    maskInverted: false,
    maskParameters: {
      baseWidth: 64,
      baseHeight: 64,
    },
  };
}

describe("useMaskPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    playbackClock.setTime(0);
    useTimelineStore.setState({
      clips: [],
      selectedClipIds: [],
    });
    useMaskViewStore.setState({
      selectedMaskByClipId: {},
      sam2EditorMaskByClipId: {},
      isMaskTabActive: false,
      pendingDrawRequest: null,
      interactionContext: null,
      sam2LivePreviewByClipId: {},
      brushTool: "gizmo",
    });
    useAssetStore.setState({
      assets: [],
    });
    vi.mocked(getRuntimeStatus).mockResolvedValue({
      backend: {
        status: "ok",
        mode: "development",
        frontendBuildPresent: true,
      },
      comfyui: {
        status: "disconnected",
        url: "",
        error: null,
      },
      sam2: {
        status: "unavailable",
        error: "SAM2 disabled in tests",
      },
    } satisfies RuntimeStatus);
  });

  it("promotes a preview mask to apply when leaving the mask tab", async () => {
    const parent = createParentClip("clip_preview");
    const previewMask = createSam2MaskClip(parent, "mask_preview");

    useTimelineStore.setState({
      clips: [parent, previewMask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.setState({
      selectedMaskByClipId: { [parent.id]: "mask_preview" },
      isMaskTabActive: true,
    });

    renderHook(() => useMaskPanel());

    act(() => {
      useMaskViewStore.getState().setMaskTabActive(false);
    });

    await waitFor(() => {
      const updatedMask = useTimelineStore
        .getState()
        .clips.find((clip): clip is MaskTimelineClip => clip.id === previewMask.id);
      expect(updatedMask?.maskMode).toBe("apply");
    });
  });

  it("promotes a preview mask to apply when another clip is selected", async () => {
    const previewParent = createParentClip("clip_preview");
    const previewMask = createSam2MaskClip(previewParent, "mask_preview");
    const otherParent = createParentClip("clip_other");

    useTimelineStore.setState({
      clips: [previewParent, previewMask, otherParent],
      selectedClipIds: [previewParent.id],
    });
    useMaskViewStore.setState({
      selectedMaskByClipId: { [previewParent.id]: "mask_preview" },
      isMaskTabActive: true,
    });

    renderHook(() => useMaskPanel());

    act(() => {
      useTimelineStore.setState({
        selectedClipIds: [otherParent.id],
      });
    });

    await waitFor(() => {
      const updatedMask = useTimelineStore
        .getState()
        .clips.find((clip): clip is MaskTimelineClip => clip.id === previewMask.id);
      expect(updatedMask?.maskMode).toBe("apply");
    });
  });

  it("treats unsaved live brush strokes as clearable content", async () => {
    vi.mocked(getRuntimeStatus).mockImplementation(
      () => new Promise(() => undefined),
    );
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const parent = createParentClip("clip_brush");
    const brushMask = createBrushMaskClip(parent, "mask_live");

    useTimelineStore.setState({
      clips: [parent, brushMask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.setState({
      selectedMaskByClipId: { [parent.id]: "mask_live" },
      isMaskTabActive: true,
    });

    const { result } = renderHook(() => useMaskPanel());
    act(() => {
      ensureBrushBuffer(brushMask.id, 64, 64);
      paintBrushDot(brushMask.id, 20, 20, 8, "paint");
    });

    await waitFor(() => {
      expect(result.current.brush.hasBrushAsset).toBe(true);
    });

    disposeBrushBuffer(brushMask.id);
    consoleErrorSpy.mockRestore();
  });

  it("starts newly drawn brush masks in paint mode from the gizmo default", () => {
    const parent = createParentClip("clip_brush_new");
    useTimelineStore.setState({
      clips: [parent],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setBrushTool("gizmo");

    const { result } = renderHook(() => useMaskPanel());

    act(() => {
      result.current.panel.requestDraw("brush");
    });

    expect(useMaskViewStore.getState().brushTool).toBe("paint");
    expect(useTimelineStore.getState().clips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "mask",
          maskType: "brush",
        }),
      ]),
    );
  });
});
