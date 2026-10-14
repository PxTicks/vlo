import { renderHook } from "@testing-library/react";
import type { Application, Container } from "pixi.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  engine: {
    spriteInstance: null as null | { visible: boolean },
    activeClipRef: { current: null as null | { id: string } },
    currentClipId: null as string | null,
    syncMaskSpriteTransform: vi.fn(),
  },
  transform: {
    onSpritePointerDown: vi.fn(),
    onHandlePointerDown: vi.fn(),
  },
  mask: {
    onSpritePointerDown: vi.fn(() => false),
    onHandlePointerDown: vi.fn(),
    isMaskGizmoVisible: false,
    gizmoTarget: { mask: true },
    isMaskGizmoTargetRenderable: vi.fn(() => true),
  },
  onLiveTransform: null as null | (() => void),
  useSpriteInteraction: vi.fn(),
  useGizmoBehavior: vi.fn(),
  registerCanvasSelectable: vi.fn(),
  unregister: vi.fn(),
  requestLiveSceneTransformSync: vi.fn(),
}));

vi.mock("../../../renderer", () => ({
  useTrackRenderEngine: () => mocks.engine,
}));
vi.mock("../interaction/useTransformInteractionController", () => ({
  useTransformInteractionController: (...args: unknown[]) => {
    mocks.onLiveTransform = args[4] as () => void;
    return mocks.transform;
  },
}));
vi.mock("../interaction/useMaskInteractionController", () => ({
  useMaskInteractionController: () => mocks.mask,
}));
vi.mock("../interaction/useCanvasSelectionManager", () => ({
  registerCanvasSelectable: mocks.registerCanvasSelectable,
}));
vi.mock("../useSpriteInteraction", () => ({
  useSpriteInteraction: mocks.useSpriteInteraction,
}));
vi.mock("../useGizmoBehavior", () => ({
  useGizmoBehavior: mocks.useGizmoBehavior,
}));
vi.mock("../../services/liveSceneTransformSync", () => ({
  requestLiveSceneTransformSync: mocks.requestLiveSceneTransformSync,
}));

import { useCanvasSelectionStore } from "../../useCanvasSelectionStore";
import { useTrackRenderer } from "../useTrackRenderer";

const container = {} as Container;
const overlay = {} as Container;
const app = {} as Application;

function renderTrack(interactionsEnabled = true) {
  return renderHook(() =>
    useTrackRenderer(
      "track-1",
      app,
      container,
      overlay,
      3,
      { width: 1920, height: 1080 },
      undefined,
      null,
      null,
      null,
      interactionsEnabled,
    ),
  );
}

function lastGizmoCall(index: 0 | 1) {
  const calls = mocks.useGizmoBehavior.mock.calls;
  return calls[calls.length - 2 + index];
}

describe("useTrackRenderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.engine.spriteInstance = { visible: true };
    mocks.engine.activeClipRef = { current: { id: "clip-1" } };
    mocks.engine.currentClipId = "clip-1";
    mocks.mask.isMaskGizmoVisible = false;
    mocks.mask.onSpritePointerDown.mockReturnValue(false);
    mocks.registerCanvasSelectable.mockReturnValue(mocks.unregister);
    useCanvasSelectionStore.setState({
      activeSelection: { kind: "clip", clipId: "clip-1" },
    });
  });

  it("routes sprite presses to masks first, then transforms", () => {
    renderTrack();
    const handlers = mocks.useSpriteInteraction.mock.calls.at(-1)?.[1] as {
      onSpritePointerDown: (event: unknown) => void;
    };

    handlers.onSpritePointerDown("press-1");
    expect(mocks.mask.onSpritePointerDown).toHaveBeenCalledWith("press-1");
    expect(mocks.transform.onSpritePointerDown).toHaveBeenCalledWith("press-1");

    mocks.mask.onSpritePointerDown.mockReturnValue(true);
    handlers.onSpritePointerDown("press-2");
    expect(mocks.transform.onSpritePointerDown).toHaveBeenCalledTimes(1);
  });

  it("syncs masks and the live scene when a transform drags the sprite", () => {
    renderTrack();
    mocks.onLiveTransform?.();
    expect(mocks.engine.syncMaskSpriteTransform).toHaveBeenCalled();
    expect(mocks.requestLiveSceneTransformSync).toHaveBeenCalled();
  });

  it("registers the sprite as a canvas selectable while it exists", () => {
    const { unmount } = renderTrack();
    const selectable = mocks.registerCanvasSelectable.mock.calls[0][0];
    expect(selectable).toMatchObject({
      id: "clip:track-1",
      kind: "clip",
      displayObject: mocks.engine.spriteInstance,
    });
    expect(selectable.getClipId()).toBe("clip-1");
    expect(selectable.getSelectionOrder()).toBe(3);
    expect(selectable.isEnabled()).toBe(true);

    mocks.engine.spriteInstance!.visible = false;
    expect(selectable.isEnabled()).toBe(false);
    mocks.engine.spriteInstance!.visible = true;
    mocks.engine.activeClipRef.current = null;
    expect(selectable.isEnabled()).toBe(false);
    expect(selectable.getClipId()).toBeNull();

    unmount();
    expect(mocks.unregister).toHaveBeenCalled();
  });

  it("skips registration without a sprite", () => {
    mocks.engine.spriteInstance = null;
    renderTrack();
    expect(mocks.registerCanvasSelectable).not.toHaveBeenCalled();
  });

  it("shows the clip gizmo only for the selected, drawn clip without a mask gizmo", () => {
    renderTrack();
    const [clipTarget, clipEnabled, , , clipHandlers, clipRenderable] =
      lastGizmoCall(0);
    expect(clipTarget).toBe(mocks.engine.spriteInstance);
    expect(clipEnabled).toBe(true);
    expect(clipHandlers.onHandlePointerDown).toBe(
      mocks.transform.onHandlePointerDown,
    );
    expect(clipRenderable()).toBe(true);
    mocks.engine.spriteInstance!.visible = false;
    expect(clipRenderable()).toBe(false);

    const [maskTarget, maskEnabled, , , maskHandlers, maskRenderable] =
      lastGizmoCall(1);
    expect(maskTarget).toBe(mocks.mask.gizmoTarget);
    expect(maskEnabled).toBe(false);
    expect(maskHandlers.onHandlePointerDown).toBe(
      mocks.mask.onHandlePointerDown,
    );
    expect(maskRenderable).toBe(mocks.mask.isMaskGizmoTargetRenderable);
  });

  it("hands the gizmo to the mask while a mask gizmo is visible", () => {
    mocks.mask.isMaskGizmoVisible = true;
    renderTrack();
    expect(lastGizmoCall(0)[1]).toBe(false);
    expect(lastGizmoCall(1)[1]).toBe(true);
  });

  it("disables gizmos for other selections and when interactions are off", () => {
    useCanvasSelectionStore.setState({
      activeSelection: { kind: "clip", clipId: "other" },
    });
    renderTrack();
    expect(lastGizmoCall(0)[1]).toBe(false);

    useCanvasSelectionStore.setState({
      activeSelection: { kind: "clip", clipId: "clip-1" },
    });
    mocks.mask.isMaskGizmoVisible = true;
    renderTrack(false);
    expect(lastGizmoCall(0)[1]).toBe(false);
    expect(lastGizmoCall(1)[1]).toBe(false);
    expect(mocks.useSpriteInteraction.mock.calls.at(-1)?.[2]).toBe(false);
  });
});
