import { useEffect, useRef } from "react";
import type { Application, Container, FederatedPointerEvent } from "pixi.js";
import { SelectionGizmo, type GizmoTarget } from "../utils/SelectionGizmo";
import { playbackClock } from "../services/PlaybackClock";

interface GizmoInteractionHandlers {
  onHandlePointerDown: (e: FederatedPointerEvent, key: string) => void;
}

export function useGizmoBehavior(
  target: GizmoTarget | null,
  isSelected: boolean,
  app: Application | null,
  viewport: Container | null,
  interactions: GizmoInteractionHandlers,
) {
  const gizmoRef = useRef<SelectionGizmo | null>(null);

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

    const handleKeys = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    handleKeys.forEach((key) => {
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
      if (gizmoRef.current && !gizmoRef.current.destroyed) {
        gizmoRef.current.update(target, viewport.scale.x);
      }
    };

    ticker.add(update);
    const unsubscribeClock = playbackClock.subscribe(() => update());
    update();

    return () => {
      ticker.remove(update);
      unsubscribeClock();
    };
  }, [app, target, viewport, isSelected]);
}
