import { act, renderHook } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Application, Container, FederatedPointerEvent, Sprite } from "pixi.js";
import type {
  TimelineClip,
  MaskTimelineClip,
} from "../../../../../types/TimelineTypes";
import { useTimelineStore, TICKS_PER_SECOND } from "../../../../timeline";
import { useMaskViewStore } from "../../../../masks/store/useMaskViewStore";
import { createMaskLayoutTransforms } from "../../../../masks/model/maskFactory";
import { useMaskInteractionController } from "../useMaskInteractionController";
import { useTransformInteractionController } from "../useTransformInteractionController";
import { useCanvasSelectionManager } from "../useCanvasSelectionManager";
import { playbackClock } from "../../../services/PlaybackClock";
import { useCanvasSelectionStore } from "../../../useCanvasSelectionStore";

const {
  mockEnsureBrushBuffer,
  mockGetBrushBuffer,
  mockHydrateBrushBufferFromUrl,
  mockPaintBrushDot,
  mockPaintBrushStroke,
  mockSubscribeToBrushBuffer,
  mockFlushBrushMaskCommit,
} = vi.hoisted(() => ({
  mockEnsureBrushBuffer: vi.fn(),
  mockGetBrushBuffer: vi.fn(() => null),
  mockHydrateBrushBufferFromUrl: vi.fn(),
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

describe("useMaskInteractionController", () => {
  beforeEach(() => {
    playbackClock.setTime(0);
    mockEnsureBrushBuffer.mockClear();
    mockGetBrushBuffer.mockClear();
    mockHydrateBrushBufferFromUrl.mockClear();
    mockPaintBrushDot.mockClear();
    mockPaintBrushStroke.mockClear();
    mockSubscribeToBrushBuffer.mockClear();
    mockFlushBrushMaskCommit.mockClear();
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

  it("hands the visible gizmo back to the clip when the clip becomes active", () => {
    const trackId = useTimelineStore.getState().tracks[0].id;
    const parent = createParentClip(trackId);
    const mask = createMaskClip(parent, "mask_selected");

    useTimelineStore.setState({
      clips: [parent, mask],
      selectedClipIds: [parent.id],
    });
    useMaskViewStore.getState().setSelectedMask(parent.id, "mask_selected");

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
    expect(updatedMask?.maskPoints?.[1].timeTicks).toBe(4000);

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

  it("commits a brush mask when the stroke ends", () => {
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

    act(() => {
      onPointerUp?.({} as unknown as FederatedPointerEvent);
    });

    expect(mockPaintBrushDot).toHaveBeenCalledWith(
      brushMask.id,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      "paint",
    );
    expect(mockFlushBrushMaskCommit).toHaveBeenCalledWith(brushMask.id);
  });
});
