import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeStatus } from "../../../../types/RuntimeStatus";
import type { MaskCompositionComponent } from "../../../../types/Components";
import type {
  AssetBackedClipType, AssetBackedTimelineClip, MaskTimelineClip, TimelineClip, } from "../../../../types/TimelineTypes";
import { playbackClock } from "../../../../core/playback/PlaybackClock";
import { TICKS_PER_SECOND } from "../../../timeline";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { useAssetStore } from "../../../userAssets";
import { useMaskViewStore } from "../../store/useMaskViewStore";
import {
  generateMaskFrame,
  generateMaskVideo,
  registerSourceVideo,
} from "../../services/sam2Api";
import {
  disposeBrushBuffer,
  ensureBrushBuffer,
  paintBrushDot,
} from "../../runtime/brushBufferRegistry";
import { useMaskPanel } from "../useMaskPanel";
import {
  getRuntimeCapabilities,
  getRuntimeCapability,
  getRuntimeStatus,
} from "../../../../services/runtimeApi";
import { useRuntimeCapabilityStore } from "../../../runtimeCapabilities";
import type { RuntimeCapability } from "../../../../types/RuntimeStatus";

function sam2Capability(
  overrides: Partial<RuntimeCapability> = {},
): RuntimeCapability {
  return {
    id: "sam2",
    label: "SAM2",
    state: "available_unverified",
    canAttempt: true,
    verifiedThrough: "environment",
    checkedAt: "2026-08-25T12:00:00Z",
    selectedModel: "sam2.1_hiera_large.pt",
    device: { requested: "auto", resolved: "cuda", proven: false, fallback: false },
    models: [],
    checks: [],
    lastFailure: null,
    ...overrides,
  };
}

function stubSam2Capability(capability = sam2Capability()): void {
  vi.mocked(getRuntimeCapabilities).mockResolvedValue({
    capabilities: [capability],
    environment: null as never,
  });
  vi.mocked(getRuntimeCapability).mockResolvedValue({
    capability,
    environment: null as never,
  });
}

vi.mock("../../../../services/runtimeApi", () => ({
  getRuntimeStatus: vi.fn(),
  getRuntimeCapabilities: vi.fn(),
  getRuntimeCapability: vi.fn(),
}));

vi.mock("../../services/sam2Api", () => ({
  clearSam2EditorSession: vi.fn(async () => undefined),
  generateMaskFrame: vi.fn(),
  generateMaskVideo: vi.fn(),
  initSam2EditorSession: vi.fn(async () => ({})),
  registerSourceVideo: vi.fn(),
}));

function createParentClip(
  id: string,
  type: AssetBackedClipType = "video",
): AssetBackedTimelineClip {
  const duration = TICKS_PER_SECOND;
  return {
    id,
    trackId: useTimelineStore.getState().tracks[0].id,
    type,
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
  } as AssetBackedTimelineClip;
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
      maskPreviewTarget: null,
    });
    useAssetStore.setState({
      assets: [],
    });
    // The capability store is a module singleton: without a reset, one test's
    // answer leaks into the next.
    useRuntimeCapabilityStore.getState().reset();
    stubSam2Capability();
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

  it("keeps the editor equation visible when mask evaluation is off", () => {
    const parent = createParentClip("clip_disabled", "video");
    const mask = createBrushMaskClip(parent, "mask_1", "apply");
    const composition: MaskCompositionComponent = {
      id: "mask_composition_disabled",
      type: "mask_composition",
      parameters: {
        expressionEnabled: false,
        compositeTransformations: [],
      },
    };
    parent.components = [...(parent.components ?? []), composition];

    useTimelineStore.setState({
      clips: [parent, mask],
      selectedClipIds: [parent.id],
    });

    const { result } = renderHook(() => useMaskPanel());

    expect(result.current.mask.maskExpressionEnabled).toBe(false);
    expect(result.current.mask.maskBooleanExpression).toEqual({
      kind: "mask_ref",
      maskId: "mask_1",
    });
  });

  it("generates a PNG SAM2 mask asset for image clips", async () => {
    stubSam2Capability();
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
        status: "available",
        error: null,
      },
    } satisfies RuntimeStatus);

    const parent = createParentClip("clip_image", "image");
    const mask = createSam2MaskClip(parent, "mask_image", "apply");
    mask.maskPoints = [
      { x: 0.5, y: 0.5, label: 1, timeTicks: 1200 },
    ];
    const canonicalMaskPoints = [
      { x: 0.5, y: 0.5, label: 1, timeTicks: 0 },
    ];

    const sourceFile = new File(["image-bytes"], "poster.png", {
      type: "image/png",
    });
    const parentAsset = {
      id: parent.assetId,
      type: "image" as const,
      name: "poster.png",
      src: "poster.png",
      hash: "sam2-image-parent-hash",
      file: sourceFile,
      createdAt: 0,
    };
    const addLocalAsset = vi.fn(async (file: File, _metadata?: unknown) => ({
      id: "sam2_generated_asset",
      type: "image" as const,
      name: file.name,
      src: "sam2_generated.png",
      hash: "generated-image-hash",
      file,
      createdAt: 0,
    }));
    const deleteAsset = vi.fn(async () => undefined);

    useTimelineStore.setState({
      clips: [parent, mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.setState({
      selectedMaskByClipId: { [parent.id]: "mask_image" },
      isMaskTabActive: true,
    });
    useAssetStore.setState({
      assets: [parentAsset],
      addLocalAsset,
      deleteAsset,
    });

    vi.mocked(registerSourceVideo).mockResolvedValue({
      sourceId: "sam2_source_image",
      width: 1920,
      height: 1080,
      fps: 25,
      frameCount: 1,
      durationSec: 0.04,
    });
    vi.mocked(generateMaskFrame).mockResolvedValue({
      blob: new Blob(["mask-png"], { type: "image/png" }),
      width: 1920,
      height: 1080,
      frameIndex: 0,
      timeTicks: 0,
    });
    vi.mocked(generateMaskVideo).mockReset();

    const { result } = renderHook(() => useMaskPanel());

    await act(async () => {
      await result.current.sam2.generateSam2Mask();
    });

    await waitFor(() => {
      expect(registerSourceVideo).toHaveBeenCalledWith(
        sourceFile,
        "sam2-image-parent-hash",
      );
      expect(generateMaskFrame).toHaveBeenCalledWith({
        sourceId: "sam2_source_image",
        points: canonicalMaskPoints,
        ticksPerSecond: TICKS_PER_SECOND,
        timeTicks: 0,
        maskId: "mask_image",
      });
      expect(generateMaskVideo).not.toHaveBeenCalled();
      expect(addLocalAsset).toHaveBeenCalledTimes(1);
    });

    const savedFile = addLocalAsset.mock.calls[0]?.[0] as File;
    const savedMetadata = addLocalAsset.mock.calls[0]?.[1];
    expect(savedFile.name).toMatch(/_sam2_mask_image_\d+\.png$/);
    expect(savedFile.type).toBe("image/png");
    expect(savedMetadata).toEqual({
      source: "sam2_mask",
      parentAssetId: parent.assetId,
      parentClipId: parent.id,
      maskClipId: mask.id,
      pointCount: 1,
      sourceHash: "sam2-image-parent-hash",
    });

    const updatedMask = useTimelineStore
      .getState()
      .clips.find((clip): clip is MaskTimelineClip => clip.id === mask.id);
    expect(updatedMask?.sam2MaskAssetId).toBe("sam2_generated_asset");
    expect(updatedMask?.maskPoints).toEqual(canonicalMaskPoints);
  });

  it("follows a diagnostics recheck without another SAM2 action", async () => {
    // The panel subscribes to the shared store rather than copying it: a
    // recheck from the Runtime & Diagnostics view has to reach an
    // already-mounted panel, not wait for the next SAM2 action.
    stubSam2Capability(
      sam2Capability({
        state: "blocked",
        canAttempt: false,
        verifiedThrough: "discovered",
        checks: [
          {
            id: "package.sam2",
            status: "fail",
            stage: "environment",
            code: "package_missing",
            summary: "The sam2 package is not installed",
          },
        ],
      }),
    );

    const parent = createParentClip("clip_live", "image");
    const mask = createSam2MaskClip(parent, "mask_live", "apply");
    useTimelineStore.setState({
      clips: [parent, mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.setState({
      selectedMaskByClipId: { [parent.id]: "mask_live" },
      isMaskTabActive: true,
    });

    const { result } = renderHook(() => useMaskPanel());

    await waitFor(() => {
      expect(result.current.sam2.isSam2Available).toBe(false);
    });
    expect(result.current.sam2.sam2AvailabilityFailure?.code).toBe(
      "package_missing",
    );

    // Someone installs the package and rechecks from the diagnostics view.
    vi.mocked(getRuntimeCapability).mockResolvedValue({
      capability: sam2Capability(),
      environment: null as never,
    });
    await act(async () => {
      await useRuntimeCapabilityStore.getState().refreshCapability("sam2");
    });

    expect(result.current.sam2.isSam2Available).toBe(true);
    expect(result.current.sam2.sam2AvailabilityError).toBeNull();
  });

  it("marks SAM2 mask generation busy while availability is pending", async () => {
    let resolveCapabilities: () => void = () => undefined;
    vi.mocked(getRuntimeCapabilities).mockReturnValue(
      new Promise((resolve) => {
        resolveCapabilities = () =>
          resolve({
            capabilities: [
              sam2Capability({
                state: "blocked",
                canAttempt: false,
                verifiedThrough: "discovered",
                checks: [
                  {
                    id: "package.sam2",
                    status: "fail",
                    stage: "environment",
                    code: "package_missing",
                    summary: "The sam2 package is not installed",
                  },
                ],
              }),
            ],
            environment: null as never,
          });
      }),
    );

    const parent = createParentClip("clip_pending", "image");
    const mask = createSam2MaskClip(parent, "mask_pending", "apply");
    mask.maskPoints = [{ x: 0.5, y: 0.5, label: 1, timeTicks: 0 }];

    const sourceFile = new File(["image-bytes"], "poster.png", {
      type: "image/png",
    });
    const parentAsset = {
      id: parent.assetId,
      type: "image" as const,
      name: "poster.png",
      src: "poster.png",
      hash: "sam2-pending-parent-hash",
      file: sourceFile,
      createdAt: 0,
    };

    useTimelineStore.setState({
      clips: [parent, mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.setState({
      selectedMaskByClipId: { [parent.id]: "mask_pending" },
      isMaskTabActive: false,
    });
    useAssetStore.setState({
      assets: [parentAsset],
    });

    const { result } = renderHook(() => useMaskPanel());
    let generatePromise: Promise<void> = Promise.resolve();

    act(() => {
      generatePromise = result.current.sam2.generateSam2Mask();
    });

    expect(result.current.sam2.isSam2Generating).toBe(true);

    await act(async () => {
      resolveCapabilities();
      await generatePromise;
    });

    expect(result.current.sam2.isSam2Generating).toBe(false);
    // The classified cause reaches the surface, not a generic "unavailable".
    expect(result.current.sam2.sam2GenerateError).toBe(
      "The sam2 package is not installed",
    );
    expect(result.current.sam2.sam2AvailabilityFailure?.code).toBe(
      "package_missing",
    );
  });

  it("drops the mask preview target when leaving the mask tab", async () => {
    const parent = createParentClip("clip_preview");
    const previewMask = createSam2MaskClip(parent, "mask_preview");

    useTimelineStore.setState({
      clips: [parent, previewMask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.setState({
      selectedMaskByClipId: { [parent.id]: "mask_preview" },
      isMaskTabActive: true,
      maskPreviewTarget: { clipId: parent.id, maskId: "mask_preview" },
    });

    renderHook(() => useMaskPanel());

    act(() => {
      useMaskViewStore.getState().setMaskTabActive(false);
    });

    await waitFor(() => {
      expect(useMaskViewStore.getState().maskPreviewTarget).toBeNull();
    });
  });

  it("drops the mask preview target when another clip is selected", async () => {
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
      maskPreviewTarget: { clipId: previewParent.id, maskId: "mask_preview" },
    });

    renderHook(() => useMaskPanel());

    act(() => {
      useTimelineStore.setState({
        selectedClipIds: [otherParent.id],
      });
    });

    await waitFor(() => {
      expect(useMaskViewStore.getState().maskPreviewTarget).toBeNull();
    });
  });

  it("treats unsaved live brush strokes as clearable content", async () => {
    vi.mocked(getRuntimeCapabilities).mockImplementation(
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
      ensureBrushBuffer(brushMask.id, 64, 64, {
        render: vi.fn(),
      } as never);
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
