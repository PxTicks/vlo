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
import { playbackClock } from "../../../services/PlaybackClock";

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

  // Register mask component on parent
  if (parent.type !== "mask") {
    parent.clipComponents = [
      ...(parent.clipComponents ?? []),
      {
        clipId: id,
        componentType: "mask",
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

describe("useMaskInteractionController", () => {
  beforeEach(() => {
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
      useMaskInteractionController(sprite, activeClipRef, app, viewport),
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
        ? (parentClip.clipComponents ?? [])
            .filter((component) => component.componentType === "mask")
            .map((component) => component.clipId)
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

    const { result } = renderHook(() =>
      useMaskInteractionController(sprite, activeClipRef, app, viewport),
    );

    expect(result.current.isMaskGizmoVisible).toBe(true);
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
      useMaskInteractionController(sprite, activeClipRef, app, viewport),
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
      useMaskInteractionController(sprite, activeClipRef, app, viewport),
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
      useMaskInteractionController(sprite, activeClipRef, app, viewport),
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
      useMaskInteractionController(sprite, activeClipRef, app, viewport),
    );

    const consumed = result.current.onSpritePointerDown({
      button: 0,
      stopPropagation: vi.fn(),
      global: { x: 0, y: 0 },
    } as unknown as FederatedPointerEvent);
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
});
