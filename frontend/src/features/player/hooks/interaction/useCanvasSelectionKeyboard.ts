import { useEffect } from "react";
import { useTimelineStore } from "../../../timeline";
import { useMaskViewStore } from "../../../masks/store/useMaskViewStore";
import { useCanvasSelectionStore } from "../../useCanvasSelectionStore";
import { useEditorFocusStore } from "../../../../app/focus/useEditorFocusStore";

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

export function useCanvasSelectionKeyboard() {
  const removeClip = useTimelineStore((state) => state.removeClip);
  const removeClips = useTimelineStore((state) => state.removeClips);
  const removeClipMask = useTimelineStore((state) => state.removeClipMask);
  const selectClip = useTimelineStore((state) => state.selectClip);
  const setSelectedMask = useMaskViewStore((state) => state.setSelectedMask);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isEditableTextTarget(event.target)) return;
      if (isMaskEquationTarget(event.target)) return;

      // Canvas-scoped deletion only fires when the canvas owns the keyboard.
      // This single check replaces the old asset-selection / canvas-selection
      // cross-guards that each handler used to reconstruct independently.
      if (useEditorFocusStore.getState().region !== "canvas") return;

      const selectionStore = useCanvasSelectionStore.getState();
      const activeSelection = selectionStore.activeSelection;
      if (!activeSelection) return;

      event.preventDefault();

      // `activeSelection` mirrors the gizmo actually rendered on the canvas: it
      // only resolves to a mask while mask editing is active, otherwise it is
      // the clip (see useCanvasSelectionManager). Delete therefore acts on
      // exactly the indicated object instead of walking through every mask.
      if (activeSelection.kind === "mask") {
        removeClipMask(activeSelection.clipId, activeSelection.maskId);
        // Fall back to the clip's transform gizmo rather than advancing to the
        // next mask; a further, deliberate Delete then removes the clip. This
        // is what prevents a held Delete from cascading through every mask.
        setSelectedMask(activeSelection.clipId, null);
        selectClip(activeSelection.clipId, false);
        selectionStore.selectClip(activeSelection.clipId);
        return;
      }

      const { selectedClipIds } = useTimelineStore.getState();
      const clipIdsToRemove = selectedClipIds.includes(activeSelection.clipId)
        ? selectedClipIds
        : [activeSelection.clipId];

      if (clipIdsToRemove.length > 1) {
        removeClips(clipIdsToRemove);
      } else {
        removeClip(activeSelection.clipId);
      }
      selectClip(null);
      selectionStore.clearSelection();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [removeClip, removeClips, removeClipMask, selectClip, setSelectedMask]);
}
