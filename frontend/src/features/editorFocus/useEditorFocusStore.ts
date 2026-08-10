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
  DATA_EDITOR_REGION,
  EDITOR_REGIONS,
  type EditorRegion,
} from "../../core/shell/editorRegions";
import {
  attachEditorRegionFocusAuthority,
  DATA_EDITOR_REGION,
  type EditorRegion,
  type EditorRegionClaimant,
} from "../../core/shell/editorRegions";

interface EditorFocusState {
  region: EditorRegion | null;
  /**
   * Which region root claimed the current region, when one identified itself.
   * Only used to decide whether a `releaseRegion` still applies; nothing reads
   * it to render. Cleared with the region, so at most one detached element is
   * ever held.
   */
  claimant: EditorRegionClaimant | null;
  setRegion: (
    region: EditorRegion | null,
    claimant?: EditorRegionClaimant | null,
  ) => void;
  /** Drops ownership only if `claimant` is the one that still holds it. */
  releaseRegion: (claimant: EditorRegionClaimant) => void;
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
  claimant: null,
  setRegion: (region, claimant = null) =>
    set((state) =>
      state.region === region && state.claimant === claimant
        ? state
        : { region, claimant: region === null ? null : claimant },
    ),
  releaseRegion: (claimant) =>
    set((state) =>
      state.claimant === claimant ? { region: null, claimant: null } : state,
    ),
}));

/** Canonical Zustand identity exposed only through the trusted host directory. */
export function getEditorFocusStoreForTrustedHostAccess(): typeof useEditorFocusStore {
  return useEditorFocusStore;
}

/**
 * Editor surfaces are mounted by the shell, which cannot import this feature
 * (`src/core` never depends on `src/features`). This hands the shell the two
 * operations a stage mount needs — claim on interaction, release when the
 * surface it belongs to goes away — so keyboard ownership still has exactly one
 * owner. Installed at module load, alongside the store it drives.
 */
attachEditorRegionFocusAuthority({
  claim: (region, claimant) =>
    useEditorFocusStore.getState().setRegion(region, claimant),
  release: (claimant) => useEditorFocusStore.getState().releaseRegion(claimant),
});

/**
 * Props to spread on a region's root element so it claims keyboard ownership
 * when the user interacts with it. Pointer-down capture is the primary signal
 * (it works for non-focusable surfaces like the Pixi canvas and empty timeline
 * space); the `data-editor-region` attribute lets the document-level focus
 * reconciler map real DOM focus (tab navigation, clicking inputs) back to the
 * same region. See {@link useEditorFocusReconciler}.
 *
 * The claim records the region root it came from, so a claimant that later
 * releases (a shell stage losing its surface) can tell its own claim from an
 * identically-named one another area has since taken.
 */
export function useRegionFocus(region: EditorRegion) {
  const setRegion = useEditorFocusStore((state) => state.setRegion);
  return useMemo(
    () => ({
      [DATA_EDITOR_REGION]: region,
      onPointerDownCapture: (event: { readonly currentTarget: object }) =>
        setRegion(region, event.currentTarget),
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

interface ResolvedRegionClaim {
  readonly region: EditorRegion | null;
  readonly claimant: EditorRegionClaimant | null;
}

/**
 * The region root a node belongs to. Resolving the element as well as the name
 * keeps DOM focus and pointer claims on the same identity: focusing an input
 * inside a surface re-asserts that surface's claim rather than replacing it
 * with an anonymous one.
 */
function resolveRegionFromNode(node: EventTarget | null): ResolvedRegionClaim {
  if (!(node instanceof HTMLElement)) return { region: null, claimant: null };
  const root = node.closest(`[${DATA_EDITOR_REGION}]`);
  const region = root?.getAttribute(DATA_EDITOR_REGION) ?? null;
  return {
    region: (region as EditorRegion | null) ?? null,
    claimant: region === null ? null : root,
  };
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
      const { region, claimant } = resolveRegionFromNode(target);
      useEditorFocusStore.getState().setRegion(region, claimant);
    };

    const handleFocusIn = (event: FocusEvent) => {
      syncRegion(event.target);
    };

    syncRegion(document.activeElement);
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, []);
}
