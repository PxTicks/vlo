import { useEffect, useLayoutEffect, useRef } from "react";
import type { Application, FederatedPointerEvent } from "pixi.js";
import { useTimelineStore } from "../../../timeline";
import { useMaskViewStore } from "../../../masks/store/useMaskViewStore";
import { useCanvasSelectionStore } from "../../useCanvasSelectionStore";

export type CanvasSelectableKind = "clip" | "mask";

export interface CanvasSelectableDisplayObject {
  destroyed: boolean;
  visible: boolean;
  containsPoint?: (point: { x: number; y: number }) => boolean;
  getBounds: () => { x: number; y: number; width: number; height: number };
}

export interface CanvasSelectableRegistration {
  id: string;
  kind: CanvasSelectableKind;
  displayObject: CanvasSelectableDisplayObject;
  getClipId: () => string | null;
  getSelectionOrder: () => number;
  onPointerDown: (event: FederatedPointerEvent) => boolean | void;
  containsGlobalPoint?: (global: { x: number; y: number }) => boolean;
  isEnabled?: () => boolean;
}

const canvasSelectables = new Map<string, CanvasSelectableRegistration>();

function isSelectableEnabled(selectable: CanvasSelectableRegistration): boolean {
  if (selectable.displayObject.destroyed || !selectable.displayObject.visible) {
    return false;
  }
  return selectable.isEnabled ? selectable.isEnabled() : true;
}

function containsGlobalPoint(
  displayObject: CanvasSelectableDisplayObject,
  global: { x: number; y: number },
): boolean {
  if (typeof displayObject.containsPoint === "function") {
    try {
      return displayObject.containsPoint(global);
    } catch {
      // Fall back to world bounds when the display object cannot perform
      // geometry-aware hit testing for the current state.
    }
  }

  const bounds = displayObject.getBounds();
  return (
    bounds.width > 0 &&
    bounds.height > 0 &&
    global.x >= bounds.x &&
    global.x <= bounds.x + bounds.width &&
    global.y >= bounds.y &&
    global.y <= bounds.y + bounds.height
  );
}

function compareSelectionPriority(
  left: CanvasSelectableRegistration,
  right: CanvasSelectableRegistration,
): number {
  const zOrderDelta = right.getSelectionOrder() - left.getSelectionOrder();
  if (Math.abs(zOrderDelta) > 0.0001) {
    return zOrderDelta;
  }

  const leftKindPriority = left.kind === "mask" ? 1 : 0;
  const rightKindPriority = right.kind === "mask" ? 1 : 0;
  if (rightKindPriority !== leftKindPriority) {
    return rightKindPriority - leftKindPriority;
  }

  return right.id.localeCompare(left.id);
}

export function resolveCanvasSelectableCandidates(
  registrations: Iterable<CanvasSelectableRegistration>,
  global: { x: number; y: number },
): CanvasSelectableRegistration[] {
  return Array.from(registrations)
    .filter((selectable) => isSelectableEnabled(selectable))
    .filter((selectable) =>
      selectable.containsGlobalPoint
        ? selectable.containsGlobalPoint(global)
        : containsGlobalPoint(selectable.displayObject, global),
    )
    .sort(compareSelectionPriority);
}

export function registerCanvasSelectable(
  registration: CanvasSelectableRegistration,
): () => void {
  canvasSelectables.set(registration.id, registration);

  return () => {
    const current = canvasSelectables.get(registration.id);
    if (current === registration) {
      canvasSelectables.delete(registration.id);
    }
  };
}

export function useCanvasSelectionManager(app: Application | null) {
  const selectedClipId = useTimelineStore(
    (state) => state.selectedClipIds[0] ?? null,
  );
  const selectedMaskId = useMaskViewStore((state) =>
    selectedClipId
      ? (state.selectedMaskByClipId[selectedClipId] ?? null)
      : null,
  );
  const previousSelectionRef = useRef<{
    clipId: string | null;
    maskId: string | null;
  }>({
    clipId: null,
    maskId: null,
  });

  useLayoutEffect(() => {
    const selectionStore = useCanvasSelectionStore.getState();
    const previous = previousSelectionRef.current;

    if (!selectedClipId) {
      selectionStore.clearSelection();
      previousSelectionRef.current = {
        clipId: selectedClipId,
        maskId: selectedMaskId,
      };
      return;
    }

    if (previous.clipId !== selectedClipId) {
      if (selectedMaskId) {
        selectionStore.selectMask(selectedClipId, selectedMaskId);
      } else {
        selectionStore.selectClip(selectedClipId);
      }
      previousSelectionRef.current = {
        clipId: selectedClipId,
        maskId: selectedMaskId,
      };
      return;
    }

    if (previous.maskId !== selectedMaskId) {
      if (selectedMaskId) {
        selectionStore.selectMask(selectedClipId, selectedMaskId);
      } else {
        const currentSelection = selectionStore.activeSelection;
        if (
          currentSelection?.kind === "mask" &&
          currentSelection.clipId === selectedClipId
        ) {
          selectionStore.selectClip(selectedClipId);
        }
      }
    }

    previousSelectionRef.current = {
      clipId: selectedClipId,
      maskId: selectedMaskId,
    };
  }, [selectedClipId, selectedMaskId]);

  useEffect(() => {
    if (!app) return;
    const stage = app.stage as
      | {
          on?: (
            event: string,
            handler: (event: FederatedPointerEvent) => void,
          ) => void;
          off?: (
            event: string,
            handler: (event: FederatedPointerEvent) => void,
          ) => void;
        }
      | undefined;
    if (!stage) {
      return;
    }
    if (typeof stage.on !== "function" || typeof stage.off !== "function") {
      return;
    }
    const stageOn = stage.on.bind(stage);
    const stageOff = stage.off.bind(stage);

    const handlePointerDown = (event: FederatedPointerEvent) => {
      const candidates = resolveCanvasSelectableCandidates(
        canvasSelectables.values(),
        event.global,
      );

      for (const candidate of candidates) {
        if (candidate.onPointerDown(event) !== false) {
          return;
        }
      }
    };

    stageOn("pointerdown", handlePointerDown);

    return () => {
      stageOff("pointerdown", handlePointerDown);
    };
  }, [app]);

  useEffect(() => {
    return () => {
      useCanvasSelectionStore.getState().clearSelection();
    };
  }, []);
}
