import { useEffect, useSyncExternalStore } from "react";
import { Container } from "pixi.js";
import type {
  Application,
  FederatedPointerEvent,
  PointData,
} from "pixi.js";
import { canvasToolHost } from "../../../core/shell/canvasToolHost";
import { hostContextKeys } from "../../../core/shell/contextKeys";
import { claimEditorRegion, useEditorFocusStore } from "../../editorFocus";

export interface CanvasToolSelectionHost {
  captureTargetClipId(): string | null;
  clearSelection(): void;
}

function subscribe(listener: () => void): () => void {
  const unsubscribeTools = canvasToolHost.subscribe(listener);
  const unsubscribeContext = hostContextKeys.subscribe(listener);
  return () => {
    unsubscribeTools();
    unsubscribeContext();
  };
}

function getSnapshot(): string {
  return `${canvasToolHost.getRevision()}:${hostContextKeys.getRevision()}`;
}

export function useAvailableCanvasTools() {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return canvasToolHost.listAvailable();
}

function destroyOverlayChildren(overlay: Container): void {
  for (const child of overlay.removeChildren()) {
    try {
      child.destroy({ children: true });
    } catch {
      // A trusted tool may already have destroyed one of its transient nodes.
    }
  }
}

function toPointerEvent(
  kind: "down" | "move" | "up" | "cancel",
  event: FederatedPointerEvent,
  viewport: Container,
) {
  const project = viewport.toLocal(event.global);
  const pressure =
    event.pointerType === "mouse"
      ? 0.5
      : Number.isFinite(event.pressure)
        ? event.pressure
        : 0.5;
  return Object.freeze({
    kind,
    projectPoint: Object.freeze({ x: project.x, y: project.y }),
    screenPoint: Object.freeze({ x: event.global.x, y: event.global.y }),
    pressure,
    buttons: event.buttons,
    modifiers: Object.freeze({
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
    }),
  });
}

export function useCanvasToolHost(
  app: Application | null,
  viewport: Container | null,
  selectionHost: CanvasToolSelectionHost,
): string | null {
  const revision = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const activeId = canvasToolHost.getActiveId();

  useEffect(() => {
    if (
      activeId &&
      !canvasToolHost.listAvailable().some((tool) => tool.id === activeId)
    ) {
      canvasToolHost.deactivate();
    }
  }, [activeId, revision]);

  useEffect(() => {
    if (!app || !viewport) return;
    const overlay = new Container();
    overlay.label = "extension-canvas-tool-overlay";
    overlay.zIndex = 10_000;
    overlay.eventMode = "none";
    viewport.addChild(overlay);

    const canvas = app.canvas;
    let targetClipId: string | null = null;
    const registration = canvasToolHost.attachHost({
      session: Object.freeze({
        overlay,
        get targetClipId() {
          return targetClipId;
        },
        projectToScreen: (point: PointData) => {
          const screen = viewport.toGlobal(point);
          return Object.freeze({ x: screen.x, y: screen.y });
        },
        screenToProject: (point: PointData) => {
          const project = viewport.toLocal(point);
          return Object.freeze({ x: project.x, y: project.y });
        },
        requestRender: () => app.render(),
      }),
      clearOverlay: () => destroyOverlayChildren(overlay),
      setCursor: (cursor) => {
        canvas.style.cursor = cursor ?? "";
      },
      setExtensionToolActive: (active) => {
        if (active) {
          targetClipId = selectionHost.captureTargetClipId();
          selectionHost.clearSelection();
        } else {
          targetClipId = null;
        }
      },
    });

    const handlers = [
      ["pointerdown", "down"],
      ["pointermove", "move"],
      ["pointerup", "up"],
      ["pointerupoutside", "cancel"],
      ["pointercancel", "cancel"],
    ] as const;
    const bound = handlers.map(([eventName, kind]) => {
      const handler = (event: FederatedPointerEvent) => {
        if (!canvasToolHost.getActiveId()) return;
        if (kind === "down") claimEditorRegion("canvas");
        canvasToolHost.dispatchPointer(toPointerEvent(kind, event, viewport));
      };
      app.stage.on(eventName, handler);
      return [eventName, handler] as const;
    });

    return () => {
      for (const [eventName, handler] of bound) {
        app.stage.off(eventName, handler);
      }
      registration.dispose();
      if (!viewport.destroyed) viewport.removeChild(overlay);
      overlay.destroy({ children: true });
      canvas.style.cursor = "";
    };
  }, [app, selectionHost, viewport]);

  useEffect(() => {
    if (!activeId) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (useEditorFocusStore.getState().region !== "canvas") return;
      event.preventDefault();
      canvasToolHost.deactivate();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [activeId]);

  return activeId;
}
