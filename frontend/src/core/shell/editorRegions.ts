/**
 * The editor's keyboard-focus regions. Shell-owned (extension-shell-surfaces
 * plan §3.10): the keybinding registry validates region names against this
 * list without importing the editor-focus feature; the feature's store
 * re-exports these for its own consumers.
 */
export type EditorRegion =
  | "timeline"
  | "canvas"
  | "assetBrowser"
  | "inspector"
  | "miniEditor";

export const EDITOR_REGIONS = [
  "timeline",
  "canvas",
  "assetBrowser",
  "inspector",
  "miniEditor",
] as const satisfies readonly EditorRegion[];

/**
 * Attribute marking the DOM subtree that belongs to one focus region. The
 * editor-focus feature's document-level reconciler maps real DOM focus back to
 * a region through it, so the shell has to spell it the same way.
 */
export const DATA_EDITOR_REGION = "data-editor-region";

/**
 * Who claimed a region: the DOM element carrying `data-editor-region`.
 *
 * Ownership is released by claimant, never by region name. Several distinct
 * areas legitimately claim the same region — the player frame, the surface
 * mounted in the main stage, the player aside, and the bottom dock all claim
 * `canvas` — so "the current region is called canvas" says nothing about
 * whether *this* claim is the one still in force.
 */
export type EditorRegionClaimant = object;

/**
 * Keyboard ownership for surfaces the shell mounts itself
 * (docs/configurable-docking-and-dedicated-workspaces-plan.md §4.8).
 *
 * An editor surface declares which region it owns, and the stage mount claims
 * it on pointer interaction and releases it when the surface goes away — so a
 * region-scoped shortcut can never fire against a surface the shell has already
 * replaced. The store that answers "who owns the keyboard" belongs to the
 * editor-focus feature, and `src/core` never imports a feature, so the feature
 * installs itself here instead. Same shape as the layout kernel's dock
 * selection authority: one owner, injected, with an inert default so a shell
 * component rendered without the feature still renders.
 */
export interface EditorRegionFocusAuthority {
  /** Give this region keyboard ownership on behalf of one claimant. */
  claim(region: EditorRegion, claimant: EditorRegionClaimant): void;
  /** Drop ownership, but only if this claimant still holds it. */
  release(claimant: EditorRegionClaimant): void;
}

let focusAuthority: EditorRegionFocusAuthority | null = null;

export function attachEditorRegionFocusAuthority(
  authority: EditorRegionFocusAuthority,
): void {
  focusAuthority = authority;
}

export function claimEditorRegionFromShell(
  region: EditorRegion,
  claimant: EditorRegionClaimant,
): void {
  focusAuthority?.claim(region, claimant);
}

export function releaseEditorRegionFromShell(
  claimant: EditorRegionClaimant,
): void {
  focusAuthority?.release(claimant);
}
