import { useEffect, useRef } from "react";
import type { Application, Container, FederatedPointerEvent } from "pixi.js";
import { SelectionGizmo, type GizmoTarget } from "../utils/SelectionGizmo";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import { subscribeLiveSceneTransformSync } from "../services/liveSceneTransformSync";

interface GizmoInteractionHandlers {
  onHandlePointerDown: (e: FederatedPointerEvent, key: string) => void;
}

export function useGizmoBehavior(
  target: GizmoTarget | null,
  isSelected: boolean,
  app: Application | null,
  viewport: Container | null,
  interactions: GizmoInteractionHandlers,
  /**
   * Optional per-tick gate. A gizmo must never be drawn when the object it
   * decorates is not actually on screen — otherwise a missing/invisible
   * sprite leaves a stale or zero-size gizmo behind. Return false to keep the
   * gizmo hidden (and non-interactive) while the target is not renderable.
   */
  isTargetRenderable?: () => boolean,
) {
  const gizmoRef = useRef<SelectionGizmo | null>(null);

  // Read the latest predicate from the ticker without re-subscribing each
  // render (the predicate closes over imperative Pixi state that mutates
  // outside React).
  const isTargetRenderableRef = useRef(isTargetRenderable);
  useEffect(() => {
    isTargetRenderableRef.current = isTargetRenderable;
  });

  // 1. Lifecycle: create/destroy visual overlay only.
  useEffect(() => {
    if (!viewport || !target || !isSelected) {
      if (gizmoRef.current && !gizmoRef.current.destroyed) {
        gizmoRef.current.destroy({ children: true });
      }
      gizmoRef.current = null;
      return;
    }

    const gizmo = new SelectionGizmo();
    gizmo.zIndex = 9999;
    viewport.addChild(gizmo);
    gizmoRef.current = gizmo;

    gizmo.handleKeys.forEach((key) => {
      const handle = gizmo.getHandle(key);
      if (handle) {
        handle.on("pointerdown", (e) => interactions.onHandlePointerDown(e, key));
      }
    });

    return () => {
      if (gizmoRef.current && !gizmoRef.current.destroyed) {
        gizmoRef.current.destroy({ children: true });
      }
      gizmoRef.current = null;
    };
  }, [viewport, target, isSelected, interactions]);

  // 2. Sync gizmo to sprite transform for both paused (ticker) and playing (playbackClock) modes.
  useEffect(() => {
    if (!app || !target || !viewport || !gizmoRef.current) return;

    const ticker = app.ticker;
    const update = () => {
      const gizmo = gizmoRef.current;
      if (!gizmo || gizmo.destroyed) return;

      const renderable = isTargetRenderableRef.current?.() ?? true;
      if (!renderable) {
        gizmo.visible = false;
        return;
      }

      gizmo.update(target, viewport.scale.x);
    };

    ticker.add(update);
    const unsubscribeClock = playbackClock.subscribe(() => update());
    const unsubscribeLiveSync = subscribeLiveSceneTransformSync(update);
    update();

    return () => {
      ticker.remove(update);
      unsubscribeClock();
      unsubscribeLiveSync();
    };
  }, [app, target, viewport, isSelected]);
}
