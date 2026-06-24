import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Application, Container, FederatedPointerEvent, Sprite } from "pixi.js";
import type {
  TimelineClip,
  MaskTimelineClip,
} from "../../../../../types/TimelineTypes";
import type { BrushBuffer } from "../../../../masks/runtime/brushBufferRegistry";
import { useTimelineStore, TICKS_PER_SECOND } from "../../../../timeline";
import { useMaskViewStore } from "../../../../masks/store/useMaskViewStore";
import { createMaskLayoutTransforms } from "../../../../masks/model/maskFactory";
import { useMaskInteractionController } from "../useMaskInteractionController";
import { useTransformInteractionController } from "../useTransformInteractionController";
import { useCanvasSelectionManager } from "../useCanvasSelectionManager";
import { playbackClock } from "../../../../../core/playback/PlaybackClock";
import { useCanvasSelectionStore } from "../../../useCanvasSelectionStore";
import { useTransformationViewStore } from "../../../../transformations/store/useTransformationViewStore";

const {
  mockEnsureBrushBuffer,
  mockGetBrushBuffer,
  mockHydrateBrushBufferFromUrl,
  mockIsBrushBufferEditing,
  mockIsBrushBufferReadyForSource,
  mockPaintBrushDot,
  mockPaintBrushStroke,
  mockSubscribeToBrushBuffer,
  mockFlushBrushMaskCommit,
} = vi.hoisted(() => ({
  mockEnsureBrushBuffer: vi.fn(),
  mockGetBrushBuffer: vi.fn(() => null),
  mockHydrateBrushBufferFromUrl: vi.fn(),
  mockIsBrushBufferEditing: vi.fn(() => false),
  mockIsBrushBufferReadyForSource: vi.fn(() => false),
  mockPaintBrushDot: vi.fn(),
  mockPaintBrushStroke: vi.fn(),
  mockSubscribeToBrushBuffer: vi.fn(() => () => {}),
  mockFlushBrushMaskCommit: vi.fn(),
}));

vi.mock("pixi.js", async () => {
  const originalModule = await vi.importActual("pixi.js");
  return {
    ...originalModule,
    Application: class MockApplication {
      stage = {
        on: vi.fn(),
        off: vi.fn(),
      };
      ticker = {
        add: vi.fn(),
        remove: vi.fn(),
      };
      destroy = vi.fn();
    },
  };
});

vi.mock("../../../../masks/runtime/brushBufferRegistry", () => ({
  ensureBrushBuffer: mockEnsureBrushBuffer,
  getBrushBuffer: mockGetBrushBuffer,
  hydrateBrushBufferFromUrl: mockHydrateBrushBufferFromUrl,
  isBrushBufferEditing: mockIsBrushBufferEditing,
  isBrushBufferReadyForSource: mockIsBrushBufferReadyForSource,
  paintBrushDot: mockPaintBrushDot,
  paintBrushStroke: mockPaintBrushStroke,
  subscribeToBrushBuffer: mockSubscribeToBrushBuffer,
}));

vi.mock("../../../../masks/runtime/brushAssetSync", () => ({
  flushBrushMaskCommit: mockFlushBrushMaskCommit,
}));

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

function createBrushMaskClip(
  parent: TimelineClip,
  localId: string,
): MaskTimelineClip {
  return {
    ...createMaskClip(parent, localId),
    maskType: "brush",
  };
}

function createBrushBuffer(
  overrides: Partial<BrushBuffer> = {},
): BrushBuffer {
  return {
    renderTexture: {} as never,
    canvasSize: { width: 120, height: 120 },
    paintedBounds: { x: 8, y: 12, width: 40, height: 32 },
    dirty: false,
    revision: 0,
    sourceAssetId: null,
    ...overrides,
  };
}

describe("useMaskInteractionController", () => {
  beforeEach(() => {
    playbackClock.setTime(0);
    mockEnsureBrushBuffer.mockReset();
    mockGetBrushBuffer.mockReset();
    mockGetBrushBuffer.mockReturnValue(null);
    mockHydrateBrushBufferFromUrl.mockClear();
    mockIsBrushBufferEditing.mockClear();
    mockIsBrushBufferEditing.mockReturnValue(false);
    mockIsBrushBufferReadyForSource.mockClear();
    mockIsBrushBufferReadyForSource.mockReturnValue(false);
    mockPaintBrushDot.mockClear();
    mockPaintBrushStroke.mockClear();
    mockSubscribeToBrushBuffer.mockClear();
    mockFlushBrushMaskCommit.mockClear();
    mockFlushBrushMaskCommit.mockResolvedValue(undefined);
    useCanvasSelectionStore.getState().clearSelection();
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
      brushTool: "paint",
    });
    useTransformationViewStore.setState({
      pathPanelView: "home",
      armedPathRecording: null,
      activePathEditor: null,
    });
  });

  it("creates a mask clip after drag drawing", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    useTimelineStore.getState().addClip(parent);
    useTimelineStore.getState().selectClip(parent.id);
    useMaskViewStore.getState().requestMaskDraw(parent.id, "rectangle");

    const sprite = new Sprite();
    const app = new Application();
    const viewport = new Container();
    const activeClipRef = { current: parent };

    const { result } = renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    act(() => {
      result.current.onSpritePointerDown({
        stopPropagation: vi.fn(),
        global: { x: 10, y: 10 },
      } as unknown as FederatedPointerEvent);
    });

    const onPointerMove = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointermove")?.[1];
    const onPointerUp = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointerup")?.[1];

    act(() => {
      onPointerMove?.({
        global: { x: 80, y: 90 },
      } as unknown as FederatedPointerEvent);
    });

    act(() => {
      onPointerUp?.({} as unknown as FederatedPointerEvent);
    });

    const state = useTimelineStore.getState();
    const parentClip = state.clips.find((c) => c.id === parent.id);
    const maskChildIds = new Set(
      parentClip && parentClip.type !== "mask"
        ? (parentClip.components ?? [])
            .filter((component) => component.type === "mask_ref")
            .map((component) =>
              component.type === "mask_ref"
                ? component.parameters.maskClipId
                : null,
            )
            .filter((id): id is string => id !== null)
        : [],
    );
    const maskClips = state.clips.filter(
      (clip): clip is MaskTimelineClip =>
        clip.type === "mask" && maskChildIds.has(clip.id),
    );
    expect(maskClips).toHaveLength(1);
    expect(maskClips[0].maskType).toBe("rectangle");
    expect(maskClips[0].maskMode).toBe("apply");
  });

  it("shows gizmo when a mask clip is selected on the active clip", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const mask = createMaskClip(parent, "mask_selected");

    useTimelineStore.setState({
      clips: [parent, mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_selected");
    useMaskViewStore.getState().setMaskTabActive(true);

    const viewport = new Container();
    const spriteParent = new Container();
    const sprite = new Sprite();
    spriteParent.addChild(sprite);
    viewport.addChild(spriteParent);

    const app = new Application();
    const activeClipRef = { current: parent };

    const { result } = renderHook(() => {
      useCanvasSelectionManager(null);
      return useMaskInteractionController(
        trackId,
        1,
        sprite,
        activeClipRef,
        app,
        viewport,
      );
    });

    expect(result.current.isMaskGizmoVisible).toBe(true);
  });

  it("hides the gizmo when the playhead is outside the mask's active range", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const mask: MaskTimelineClip = {
      ...createMaskClip(parent, "mask_ranged"),
      activeRange: {
        startSourceTicks: TICKS_PER_SECOND / 2,
        endSourceTicks: TICKS_PER_SECOND,
      },
    };

    useTimelineStore.setState({
      clips: [parent, mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_ranged");
    useMaskViewStore.getState().setMaskTabActive(true);

    const viewport = new Container();
    const spriteParent = new Container();
    const sprite = new Sprite();
    spriteParent.addChild(sprite);
    viewport.addChild(spriteParent);

    const app = new Application();
    const activeClipRef = { current: parent };

    // Playhead at 0 — before the mask becomes active.
    playbackClock.setTime(0);

    const { result } = renderHook(() => {
      useCanvasSelectionManager(null);
      return useMaskInteractionController(
        trackId,
        1,
        sprite,
        activeClipRef,
        app,
        viewport,
      );
    });

    expect(result.current.isMaskGizmoVisible).toBe(false);
  });

  it("shows the gizmo when the playhead is inside the mask's active range", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const mask: MaskTimelineClip = {
      ...createMaskClip(parent, "mask_ranged"),
      activeRange: {
        startSourceTicks: 0,
        endSourceTicks: TICKS_PER_SECOND,
      },
    };

    useTimelineStore.setState({
      clips: [parent, mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_ranged");
    useMaskViewStore.getState().setMaskTabActive(true);

    const viewport = new Container();
    const spriteParent = new Container();
    const sprite = new Sprite();
    spriteParent.addChild(sprite);
    viewport.addChild(spriteParent);

    const app = new Application();
    const activeClipRef = { current: parent };

    playbackClock.setTime(0);

    const { result } = renderHook(() => {
      useCanvasSelectionManager(null);
      return useMaskInteractionController(
        trackId,
        1,
        sprite,
        activeClipRef,
        app,
        viewport,
      );
    });

    expect(result.current.isMaskGizmoVisible).toBe(true);
  });

  it("hands the visible gizmo back to the clip when the clip becomes active", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const mask = createMaskClip(parent, "mask_selected");

    useTimelineStore.setState({
      clips: [parent, mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_selected");
    useMaskViewStore.getState().setMaskTabActive(true);

    const viewport = new Container();
    viewport.toLocal = vi.fn((point: { x: number; y: number }) => ({
      x: point.x,
      y: point.y,
    })) as unknown as Container["toLocal"];
    const spriteParent = new Container();
    const sprite = new Sprite();
    spriteParent.addChild(sprite);
    viewport.addChild(spriteParent);

    const app = new Application();
    const activeClipRef = { current: parent };

    const { result } = renderHook(() => {
      useCanvasSelectionManager(null);
      const maskController = useMaskInteractionController(
        trackId,
        1,
        sprite,
        activeClipRef,
        app,
        viewport,
      );
      const transformController = useTransformInteractionController(
        sprite,
        activeClipRef,
        app,
        viewport,
      );

      return { maskController, transformController };
    });

    expect(result.current.maskController.isMaskGizmoVisible).toBe(true);

    act(() => {
      result.current.transformController.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 12, y: 14 },
        originalEvent: { shiftKey: false, ctrlKey: false, metaKey: false },
      } as unknown as FederatedPointerEvent);
    });

    expect(useCanvasSelectionStore.getState().activeSelection).toEqual({
      kind: "clip",
      clipId: parent.id,
    });
    expect(result.current.maskController.isMaskGizmoVisible).toBe(false);
  });

  it("does not crash when a SAM2 mask is selected (regression)", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    // Create a SAM2 mask variant
    const sam2Mask: MaskTimelineClip = {
      ...createMaskClip(parent, "mask_sam2"),
      maskType: "sam2",
    };

    useTimelineStore.setState({
      clips: [parent, sam2Mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_sam2");

    const viewport = new Container();
    const spriteParent = new Container();
    const sprite = new Sprite();
    spriteParent.addChild(sprite);
    viewport.addChild(spriteParent);

    const app = new Application();
    const activeClipRef = { current: parent };

    // This will throw "Maximum update depth exceeded" if there's a loop
    const { result } = renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    // SAM2 masks skip the shape gizmo — they use the points overlay instead
    expect(result.current.isMaskGizmoVisible).toBe(false);
  });

  it("adds and removes SAM2 points directly on the mask clip", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const sam2Mask: MaskTimelineClip = {
      ...createMaskClip(parent, "mask_sam2"),
      maskType: "sam2",
      maskPoints: [],
      transformations: [
        ...createMaskLayoutTransforms(`${parent.id}::mask::mask_sam2`, {
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
        }),
        {
          id: "speed_1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
      ],
    };

    useTimelineStore.setState({
      clips: [parent, sam2Mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_sam2");
    useMaskViewStore.getState().setMaskTabActive(true);
    useMaskViewStore.getState().setSam2EditorMask(parent.id, "mask_sam2");

    const viewport = new Container();
    const spriteParent = new Container();
    const sprite = new Sprite();
    spriteParent.addChild(sprite);
    viewport.addChild(spriteParent);

    const app = new Application();
    const activeClipRef = { current: parent };

    const { result } = renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    let consumedAdd = false;
    act(() => {
      consumedAdd = result.current.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 0, y: 0 },
      } as unknown as FederatedPointerEvent);
    });
    expect(consumedAdd).toBe(true);

    let updatedMask = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === sam2Mask.id) as MaskTimelineClip | undefined;
    expect(updatedMask?.maskPoints).toHaveLength(1);
    expect(updatedMask?.maskPoints?.[0].label).toBe(1);
    expect(updatedMask?.maskPoints?.[0].timeTicks).toBe(0);

    playbackClock.setTime(2000);
    let consumedAddAtLaterTime = false;
    act(() => {
      consumedAddAtLaterTime = result.current.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 0, y: 0 },
      } as unknown as FederatedPointerEvent);
    });
    expect(consumedAddAtLaterTime).toBe(true);

    updatedMask = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === sam2Mask.id) as MaskTimelineClip | undefined;
    expect(updatedMask?.maskPoints).toHaveLength(2);
    expect(updatedMask?.maskPoints?.[1].timeTicks).toBe(
      TICKS_PER_SECOND / 30,
    );

    let consumedRemoveAtLaterTime = false;
    act(() => {
      consumedRemoveAtLaterTime = result.current.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 0, y: 0 },
      } as unknown as FederatedPointerEvent);
    });
    expect(consumedRemoveAtLaterTime).toBe(true);

    updatedMask = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === sam2Mask.id) as MaskTimelineClip | undefined;
    expect(updatedMask?.maskPoints ?? []).toHaveLength(1);
    expect(updatedMask?.maskPoints?.[0].timeTicks).toBe(0);
  });

  it("uses a crosshair cursor while SAM2 point editing is active", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const sam2Mask: MaskTimelineClip = {
      ...createMaskClip(parent, "mask_sam2"),
      maskType: "sam2",
      maskPoints: [],
    };

    useTimelineStore.setState({
      clips: [parent, sam2Mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_sam2");
    useMaskViewStore.getState().setMaskTabActive(true);
    useMaskViewStore.getState().setSam2EditorMask(parent.id, "mask_sam2");

    const viewport = new Container();
    const spriteParent = new Container();
    const sprite = new Sprite();
    sprite.cursor = "grab";
    spriteParent.addChild(sprite);
    viewport.addChild(spriteParent);

    const app = new Application();
    const activeClipRef = { current: parent };

    renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    expect(sprite.cursor).toBe("crosshair");

    act(() => {
      useMaskViewStore.getState().setMaskTabActive(false);
    });

    expect(sprite.cursor).toBe("grab");
  });

  it("does not place SAM2 points when the dedicated SAM2 editor is closed", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const sam2Mask: MaskTimelineClip = {
      ...createMaskClip(parent, "mask_sam2"),
      maskType: "sam2",
      maskPoints: [],
    };

    useTimelineStore.setState({
      clips: [parent, sam2Mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_sam2");
    useMaskViewStore.getState().setMaskTabActive(true);

    const viewport = new Container();
    const spriteParent = new Container();
    const sprite = new Sprite();
    spriteParent.addChild(sprite);
    viewport.addChild(spriteParent);

    const app = new Application();
    const activeClipRef = { current: parent };

    const { result } = renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    let consumed = false;
    act(() => {
      consumed = result.current.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 0, y: 0 },
      } as unknown as FederatedPointerEvent);
    });

    const updatedMask = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === sam2Mask.id) as MaskTimelineClip | undefined;
    expect(consumed).toBe(false);
    expect(updatedMask?.maskPoints ?? []).toHaveLength(0);
    expect(sprite.cursor).not.toBe("crosshair");
  });

  it("commits mask translation back to the mask clip transform stack", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const mask = createMaskClip(parent, "mask_drag");

    useTimelineStore.setState({
      clips: [parent, mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_drag");

    const viewport = new Container();
    const spriteParent = new Container();
    const sprite = new Sprite();
    spriteParent.addChild(sprite);
    viewport.addChild(spriteParent);

    const app = new Application();
    const activeClipRef = { current: parent };

    const { result } = renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    let consumed = false;
    act(() => {
      consumed = result.current.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 0, y: 0 },
      } as unknown as FederatedPointerEvent);
    });
    expect(consumed).toBe(true);

    const onPointerMove = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointermove")?.[1];
    const onPointerUp = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointerup")?.[1];

    act(() => {
      onPointerMove?.({
        global: { x: 15, y: 10 },
      } as unknown as FederatedPointerEvent);
    });
    act(() => {
      onPointerUp?.({} as unknown as FederatedPointerEvent);
    });

    const updatedMask = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === mask.id);
    const position = updatedMask?.transformations.find(
      (transform) => transform.type === "position",
    );

    expect(position?.parameters).toEqual(
      expect.objectContaining({ x: 15, y: 10 }),
    );
  });

  it("selects and drags a non-selected mask hit from the canvas", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const firstMask = createMaskClip(parent, "mask_first");
    const secondMask: MaskTimelineClip = {
      ...createMaskClip(parent, "mask_second"),
      transformations: createMaskLayoutTransforms(
        `${parent.id}::mask::mask_second`,
        {
          x: 200,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
        },
      ),
    };

    useTimelineStore.setState({
      clips: [parent, firstMask, secondMask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_first");

    const viewport = new Container();
    const spriteParent = new Container();
    const sprite = new Sprite();
    spriteParent.addChild(sprite);
    viewport.addChild(spriteParent);

    const app = new Application();
    const activeClipRef = { current: parent };

    const { result } = renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    let consumed = false;
    act(() => {
      consumed = result.current.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 200, y: 0 },
      } as unknown as FederatedPointerEvent);
    });
    expect(consumed).toBe(true);
    expect(
      useMaskViewStore.getState().selectedMaskByClipId[parent.id],
    ).toBe("mask_second");

    const onPointerMove = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointermove")?.[1];
    const onPointerUp = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointerup")?.[1];

    act(() => {
      onPointerMove?.({
        global: { x: 215, y: 10 },
      } as unknown as FederatedPointerEvent);
    });
    act(() => {
      onPointerUp?.({} as unknown as FederatedPointerEvent);
    });

    const updatedMask = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === secondMask.id);
    const position = updatedMask?.transformations.find(
      (transform) => transform.type === "position",
    );

    expect(position?.parameters).toEqual(
      expect.objectContaining({ x: 215, y: 10 }),
    );
  });

  it("locks mask corner scaling to the starting aspect ratio", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const mask: MaskTimelineClip = {
      ...createMaskClip(parent, "mask_scale"),
      transformations: createMaskLayoutTransforms(
        `${parent.id}::mask::mask_scale`,
        {
          x: 0,
          y: 0,
          scaleX: 2,
          scaleY: 1,
          rotation: 0,
        },
      ),
    };

    useTimelineStore.setState({
      clips: [parent, mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_scale");

    const viewport = new Container();
    const spriteParent = new Container();
    const sprite = new Sprite();
    spriteParent.addChild(sprite);
    viewport.addChild(spriteParent);

    const app = new Application();
    const activeClipRef = { current: parent };

    const { result } = renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    act(() => {
      result.current.onHandlePointerDown({
        altKey: false,
        stopPropagation: vi.fn(),
        global: { x: 0, y: 0 },
      } as unknown as FederatedPointerEvent, "se");
    });

    const onPointerMove = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointermove")?.[1];
    const onPointerUp = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointerup")?.[1];

    act(() => {
      onPointerMove?.({
        global: { x: 60, y: 5 },
      } as unknown as FederatedPointerEvent);
    });
    act(() => {
      onPointerUp?.({} as unknown as FederatedPointerEvent);
    });

    const updatedMask = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === mask.id) as MaskTimelineClip | undefined;
    const scaleTransform = updatedMask?.transformations.find(
      (transform) => transform.type === "scale",
    );

    expect(scaleTransform?.parameters).toEqual(
      expect.objectContaining({ x: 2.5, y: 1.25 }),
    );
  });

  it("commits mask rotation from rotate and alt-drag handles", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const mask = createMaskClip(parent, "mask_rotate");
    useTimelineStore.setState({
      clips: [parent, mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_rotate");
    const viewport = new Container();
    const sprite = new Sprite();
    viewport.addChild(sprite);
    const app = new Application();
    const activeClipRef = { current: parent };
    const { result } = renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    act(() => {
      result.current.onHandlePointerDown(
        {
          altKey: false,
          stopPropagation: vi.fn(),
          global: { x: 20, y: 0 },
        } as unknown as FederatedPointerEvent,
        "rot-ne",
      );
    });
    const move = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointermove")?.[1];
    const up = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointerup")?.[1];
    act(() => {
      move?.({ global: { x: 0, y: 20 } } as unknown as FederatedPointerEvent);
      up?.({} as unknown as FederatedPointerEvent);
    });
    const updated = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === mask.id);
    expect(
      updated?.transformations.find((transform) => transform.type === "rotation")
        ?.parameters.angle,
    ).toBeCloseTo(Math.PI / 2);

    activeClipRef.current = parent;
    act(() => {
      result.current.onHandlePointerDown(
        {
          altKey: true,
          stopPropagation: vi.fn(),
          global: { x: 20, y: 0 },
        } as unknown as FederatedPointerEvent,
        "se",
      );
    });
    expect(app.stage.on).toHaveBeenCalledWith(
      "pointermove",
      expect.any(Function),
    );
  });

  it("records a position path for an armed mask", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const mask = createMaskClip(parent, "mask_path");
    useTimelineStore.setState({
      clips: [parent, mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_path");
    useTransformationViewStore.setState({
      armedPathRecording: { clipId: mask.id, transformId: null },
    });
    const viewport = new Container();
    const sprite = new Sprite();
    viewport.addChild(sprite);
    const app = new Application();
    const activeClipRef = { current: parent };
    const { result } = renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    let consumed = false;
    act(() => {
      consumed = result.current.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 0, y: 0 },
        timeStamp: 0,
      } as unknown as FederatedPointerEvent);
    });
    expect(consumed).toBe(true);
    const move = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointermove")?.[1];
    const up = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointerup")?.[1];
    act(() => {
      move?.({
        global: { x: 30, y: 20 },
        timeStamp: 50,
      } as unknown as FederatedPointerEvent);
      up?.({} as unknown as FederatedPointerEvent);
    });
    const updated = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === mask.id);
    const position = updated?.transformations.find(
      (transform) => transform.type === "position",
    );
    expect(position?.parameters.path).toBeDefined();
    expect(useTransformationViewStore.getState().armedPathRecording).toBeNull();
    expect(useTransformationViewStore.getState().pathPanelView).toBe("path");
  });

  it("draws circles and discards shapes below the minimum size", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    useTimelineStore.setState({
      clips: [parent],
      selectedClipIds: [parent.id],
    });
    const viewport = new Container();
    const sprite = new Sprite();
    viewport.addChild(sprite);
    const app = new Application();
    const activeClipRef = { current: parent };
    const { result } = renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    useMaskViewStore.getState().requestMaskDraw(parent.id, "circle");
    act(() => {
      result.current.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 0, y: 0 },
      } as unknown as FederatedPointerEvent);
    });
    let move = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointermove")?.[1];
    let up = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointerup")?.[1];
    act(() => {
      move?.({ global: { x: 40, y: 30 } } as unknown as FederatedPointerEvent);
      up?.({} as unknown as FederatedPointerEvent);
    });
    expect(
      useTimelineStore.getState().clips.some(
        (clip) => clip.type === "mask" && clip.maskType === "circle",
      ),
    ).toBe(true);

    const before = useTimelineStore.getState().clips.length;
    useMaskViewStore.getState().requestMaskDraw(parent.id, "rectangle");
    act(() => {
      result.current.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 0, y: 0 },
      } as unknown as FederatedPointerEvent);
    });
    move = vi
      .mocked(app.stage.on)
      .mock.calls.filter((call) => call[0] === "pointermove")
      .at(-1)?.[1];
    up = vi
      .mocked(app.stage.on)
      .mock.calls.filter((call) => call[0] === "pointerup")
      .at(-1)?.[1];
    act(() => {
      move?.({ global: { x: 1, y: 1 } } as unknown as FederatedPointerEvent);
      up?.({} as unknown as FederatedPointerEvent);
    });
    expect(useTimelineStore.getState().clips).toHaveLength(before);
  });

  it("paints a brush mask without flushing while the edit session remains focused", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const brushMask = createBrushMaskClip(parent, "mask_brush");

    useTimelineStore.setState({
      clips: [parent, brushMask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_brush");
    useMaskViewStore.getState().setMaskTabActive(true);
    useMaskViewStore.getState().setBrushTool("paint");

    const viewport = new Container();
    const spriteParent = new Container();
    const sprite = new Sprite();
    spriteParent.addChild(sprite);
    viewport.addChild(spriteParent);

    const app = new Application();
    const activeClipRef = { current: parent };

    const { result } = renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    let consumed = false;
    act(() => {
      consumed = result.current.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 10, y: 14 },
      } as unknown as FederatedPointerEvent);
    });
    expect(consumed).toBe(true);

    const onPointerUp = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointerup")?.[1];
    const onPointerMove = vi
      .mocked(app.stage.on)
      .mock.calls.find((call) => call[0] === "pointermove")?.[1];

    act(() => {
      onPointerMove?.({
        global: { x: 20, y: 24 },
      } as unknown as FederatedPointerEvent);
      onPointerUp?.({} as unknown as FederatedPointerEvent);
    });

    expect(mockPaintBrushDot).toHaveBeenCalledWith(
      brushMask.id,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      "paint",
    );
    expect(mockPaintBrushStroke).toHaveBeenCalledWith(
      brushMask.id,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      "paint",
    );
    expect(mockFlushBrushMaskCommit).not.toHaveBeenCalled();
  });

  it("uses erase mode for brush dots and rejects unsupported buttons", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const brushMask = createBrushMaskClip(parent, "mask_erase");
    useTimelineStore.setState({
      clips: [parent, brushMask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_erase");
    useMaskViewStore.getState().setMaskTabActive(true);
    useMaskViewStore.getState().setBrushTool("erase");
    const viewport = new Container();
    const sprite = new Sprite();
    viewport.addChild(sprite);
    const app = new Application();
    const activeClipRef = { current: parent };
    const { result } = renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    let consumed = true;
    act(() => {
      consumed = result.current.onSpritePointerDown({
        button: 1,
        global: { x: 5, y: 5 },
      } as unknown as FederatedPointerEvent);
    });
    expect(consumed).toBe(false);
    act(() => {
      consumed = result.current.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 5, y: 5 },
      } as unknown as FederatedPointerEvent);
    });
    expect(consumed).toBe(true);
    expect(mockPaintBrushDot).toHaveBeenCalledWith(
      brushMask.id,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      "erase",
    );
  });

  it("does not hydrate a persisted brush mask over a dirty live buffer", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const brushMask: MaskTimelineClip = {
      ...createBrushMaskClip(parent, "mask_brush"),
      brushMaskAssetId: "brush-asset-1",
      brushPaintedBounds: { x: 8, y: 12, width: 40, height: 32 },
    };
    mockEnsureBrushBuffer.mockReturnValue(
      createBrushBuffer({
        dirty: true,
        sourceAssetId: null,
      }),
    );

    useTimelineStore.setState({
      clips: [parent, brushMask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_brush");

    const viewport = new Container();
    const spriteParent = new Container();
    const sprite = new Sprite();
    spriteParent.addChild(sprite);
    viewport.addChild(spriteParent);

    const app = new Application();
    const activeClipRef = { current: parent };

    renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    expect(mockEnsureBrushBuffer).toHaveBeenCalledWith(brushMask.id, 120, 120);
    expect(mockIsBrushBufferReadyForSource).not.toHaveBeenCalled();
    expect(mockHydrateBrushBufferFromUrl).not.toHaveBeenCalled();
  });

  it("restores gizmo mode when the brush mask tab focus leaves", async () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const brushMask = createBrushMaskClip(parent, "mask_brush");

    useTimelineStore.setState({
      clips: [parent, brushMask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_brush");
    useMaskViewStore.getState().setMaskTabActive(true);
    useMaskViewStore.getState().setBrushTool("paint");

    const viewport = new Container();
    const spriteParent = new Container();
    const sprite = new Sprite();
    spriteParent.addChild(sprite);
    viewport.addChild(spriteParent);

    const app = new Application();
    const activeClipRef = { current: parent };

    renderHook(() =>
      useMaskInteractionController(trackId, 1, sprite, activeClipRef, app, viewport),
    );

    act(() => {
      useMaskViewStore.getState().setMaskTabActive(false);
    });

    expect(mockFlushBrushMaskCommit).toHaveBeenCalledWith(brushMask.id);
    await waitFor(() => {
      expect(useMaskViewStore.getState().brushTool).toBe("gizmo");
    });
  });
});
