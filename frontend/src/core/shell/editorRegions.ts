/**
 * The editor's keyboard-focus regions. Shell-owned (extension-shell-surfaces
 * plan §3.10): the keybinding registry validates region names against this
 * list without importing the editor-focus feature; the feature's store
 * re-exports these for its own consumers.
 */
export type EditorRegion = "timeline" | "canvas" | "assetBrowser" | "inspector";

export const EDITOR_REGIONS = [
  "timeline",
  "canvas",
  "assetBrowser",
  "inspector",
] as const satisfies readonly EditorRegion[];
