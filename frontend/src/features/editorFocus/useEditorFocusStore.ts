import { useEffect, useMemo } from "react";
import { create } from "zustand";

/**
 * The set of editor surfaces that can own keyboard intent at any one time.
 * A `null` region means no surface currently owns the keyboard (clicks on
 * neutral chrome, dialogs, etc.), in which case region-scoped shortcuts such
 * as Delete must no-op.
 */
// Region names are shell-owned (plan §3.10); re-exported for existing imports.
export {
  EDITOR_REGIONS,
  type EditorRegion,
} from "../../core/shell/editorRegions";
import type { EditorRegion } from "../../core/shell/editorRegions";

interface EditorFocusState {
  region: EditorRegion | null;
  setRegion: (region: EditorRegion | null) => void;
}

/**
 * Single source of truth for "which surface owns the keyboard right now".
 *
 * Historically focus was reconstructed independently by every window-level
 * keydown handler from a patchwork of signals (timeline `isFocused`, mask tab
 * state, asset selection length, canvas selection). Those signals overlapped
 * and disagreed, which is what allowed Delete to act on the wrong target. This
 * store replaces that guesswork: handlers consult `region` and early-return
 * unless they own it.
 */
export const useEditorFocusStore = create<EditorFocusState>((set) => ({
  region: null,
  setRegion: (region) =>
    set((state) => (state.region === region ? state : { region })),
}));

export const DATA_EDITOR_REGION = "data-editor-region";

/**
 * Props to spread on a region's root element so it claims keyboard ownership
 * when the user interacts with it. Pointer-down capture is the primary signal
 * (it works for non-focusable surfaces like the Pixi canvas and empty timeline
 * space); the `data-editor-region` attribute lets the document-level focus
 * reconciler map real DOM focus (tab navigation, clicking inputs) back to the
 * same region. See {@link useEditorFocusReconciler}.
 */
export function useRegionFocus(region: EditorRegion) {
  const setRegion = useEditorFocusStore((state) => state.setRegion);
  return useMemo(
    () => ({
      [DATA_EDITOR_REGION]: region,
      onPointerDownCapture: () => setRegion(region),
    }),
    [region, setRegion],
  );
}

/**
 * Imperatively claim a region (for surfaces that don't render their own DOM
 * root with {@link useRegionFocus}, e.g. the Pixi stage claiming "canvas" from
 * inside a pointer handler).
 */
export function claimEditorRegion(region: EditorRegion): void {
  useEditorFocusStore.getState().setRegion(region);
}

function resolveRegionFromNode(node: EventTarget | null): EditorRegion | null {
  if (!(node instanceof HTMLElement)) return null;
  const root = node.closest(`[${DATA_EDITOR_REGION}]`);
  const region = root?.getAttribute(DATA_EDITOR_REGION) ?? null;
  return (region as EditorRegion | null) ?? null;
}

/**
 * Installs a single document-level `focusin` listener that reconciles the
 * focus store with real DOM focus. Mount once near the editor root. Keyboard
 * navigation and clicking into inputs move `document.activeElement`; this maps
 * that element to its owning region so the store tracks the DOM rather than
 * running a parallel guess. Pointer interactions on non-focusable surfaces are
 * handled by {@link useRegionFocus} / {@link claimEditorRegion} instead.
 */
export function useEditorFocusReconciler(): void {
  useEffect(() => {
    const syncRegion = (target: EventTarget | null) => {
      useEditorFocusStore.getState().setRegion(resolveRegionFromNode(target));
    };

    const handleFocusIn = (event: FocusEvent) => {
      syncRegion(event.target);
    };

    syncRegion(document.activeElement);
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, []);
}
