import { useEffect } from "react";
import {
  parseMaskClipId,
  selectMaskClipsForParent,
  useTimelineStore,
} from "../../../timeline";
import { useMaskViewStore } from "../../../masks/store/useMaskViewStore";
import { useAssetBrowserSelectionStore } from "../../../userAssets";
import { useCanvasSelectionStore } from "../../useCanvasSelectionStore";

function isEditableTextTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isMaskEquationTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('[data-mask-equation-editor="true"]') !== null
  );
}

function getFallbackMaskId(
  clipId: string,
  removedMaskId: string,
): string | null {
  const state = useTimelineStore.getState();
  const masks = selectMaskClipsForParent(state, clipId);
  const selectedIndex = masks.findIndex(
    (mask) => parseMaskClipId(mask.id)?.maskId === removedMaskId,
  );
  const fallbackMask =
    masks[selectedIndex + 1] ?? masks[selectedIndex - 1] ?? null;

  return fallbackMask ? (parseMaskClipId(fallbackMask.id)?.maskId ?? null) : null;
}

export function useCanvasSelectionKeyboard() {
  const removeClip = useTimelineStore((state) => state.removeClip);
  const removeClipMask = useTimelineStore((state) => state.removeClipMask);
  const selectClip = useTimelineStore((state) => state.selectClip);
  const setSelectedMask = useMaskViewStore((state) => state.setSelectedMask);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isEditableTextTarget(event.target)) return;
      if (isMaskEquationTarget(event.target)) return;
      if (useAssetBrowserSelectionStore.getState().selectedAssetIds.length > 0) {
        return;
      }

      const selectionStore = useCanvasSelectionStore.getState();
      const activeSelection = selectionStore.activeSelection;
      if (!activeSelection) return;

      event.preventDefault();

      if (activeSelection.kind === "mask") {
        const fallbackMaskId = getFallbackMaskId(
          activeSelection.clipId,
          activeSelection.maskId,
        );

        removeClipMask(activeSelection.clipId, activeSelection.maskId);
        setSelectedMask(activeSelection.clipId, fallbackMaskId);
        selectClip(activeSelection.clipId, false);

        if (fallbackMaskId) {
          selectionStore.selectMask(activeSelection.clipId, fallbackMaskId);
        } else {
          selectionStore.selectClip(activeSelection.clipId);
        }
        return;
      }

      removeClip(activeSelection.clipId);
      selectClip(null);
      selectionStore.clearSelection();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [removeClip, removeClipMask, selectClip, setSelectedMask]);
}
