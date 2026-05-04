import { useEffect, useMemo } from "react";
import type { Application, Container } from "pixi.js";
import { useSpriteInteraction } from "./useSpriteInteraction";
import { useGizmoBehavior } from "./useGizmoBehavior";
import { useTransformInteractionController } from "./interaction/useTransformInteractionController";
import { useMaskInteractionController } from "./interaction/useMaskInteractionController";
import { registerCanvasSelectable } from "./interaction/useCanvasSelectionManager";
import { useCanvasSelectionStore } from "../useCanvasSelectionStore";
import { useTrackRenderEngine } from "../../renderer";

/**
 * Composition hook that wires the renderer's TrackRenderEngine
 * with the player's interaction controllers (transform, mask, gizmos).
 *
 * This is the player-side hook called by TrackLayer.
 */
export function useTrackRenderer(
  trackId: string,
  app: Application | null,
  container: Container,
  zIndex: number,
  logicalDimensions: { width: number; height: number },
  registerSynchronizedPlaybackRenderer?: (
    trackId: string,
    renderer: ((time: number) => Promise<void>) | null,
  ) => void,
) {
  // 1. Delegate rendering to the renderer feature
  const {
    spriteInstance,
    activeClipRef,
    currentClipId,
    syncMaskSpriteTransform,
  } = useTrackRenderEngine(
    trackId,
    app,
    container,
    zIndex,
    logicalDimensions,
    registerSynchronizedPlaybackRenderer,
  );

  // 2. Selection state
  const activeCanvasSelection = useCanvasSelectionStore(
    (state) => state.activeSelection,
  );

  // 3. Interaction controllers
  const transformInteractionHandlers = useTransformInteractionController(
    spriteInstance,
    activeClipRef,
    app,
    container,
    syncMaskSpriteTransform,
  );
  const maskInteractionHandlers = useMaskInteractionController(
    trackId,
    zIndex,
    spriteInstance,
    activeClipRef,
    app,
    container,
  );

  // 4. Compose sprite pointer events: mask interactions first, then transform
  const spriteInteractionHandlers = useMemo(
    () => ({
      onSpritePointerDown: (
        e: Parameters<
          typeof transformInteractionHandlers.onSpritePointerDown
        >[0],
      ) => {
        const consumedByMask = maskInteractionHandlers.onSpritePointerDown(e);
        if (!consumedByMask) {
          transformInteractionHandlers.onSpritePointerDown(e);
        }
      },
    }),
    [maskInteractionHandlers, transformInteractionHandlers],
  );
  const transformGizmoInteractions = useMemo(
    () => ({
      onHandlePointerDown: transformInteractionHandlers.onHandlePointerDown,
    }),
    [transformInteractionHandlers],
  );
  const maskGizmoInteractions = useMemo(
    () => ({
      onHandlePointerDown: maskInteractionHandlers.onHandlePointerDown,
    }),
    [maskInteractionHandlers],
  );
  const isClipSelectionActive =
    !!currentClipId &&
    activeCanvasSelection?.kind === "clip" &&
    activeCanvasSelection.clipId === currentClipId;

  useEffect(() => {
    if (!spriteInstance) return;

    return registerCanvasSelectable({
      id: `clip:${trackId}`,
      kind: "clip",
      displayObject: spriteInstance,
      getClipId: () => activeClipRef.current?.id ?? null,
      getSelectionOrder: () => zIndex,
      onPointerDown: spriteInteractionHandlers.onSpritePointerDown,
      isEnabled: () => spriteInstance.visible && !!activeClipRef.current,
    });
  }, [activeClipRef, spriteInstance, spriteInteractionHandlers, trackId, zIndex]);

  // 5. Wire sprite interaction and gizmo hooks
  useSpriteInteraction(spriteInstance, spriteInteractionHandlers);
  useGizmoBehavior(
    spriteInstance,
    isClipSelectionActive && !maskInteractionHandlers.isMaskGizmoVisible,
    app,
    container,
    transformGizmoInteractions,
  );
  useGizmoBehavior(
    maskInteractionHandlers.gizmoTarget,
    maskInteractionHandlers.isMaskGizmoVisible,
    app,
    container,
    maskGizmoInteractions,
  );
}
