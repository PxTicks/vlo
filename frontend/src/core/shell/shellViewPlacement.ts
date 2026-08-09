/**
 * Where a shell view currently lives, and how to reveal it there
 * (plan §4.2, §4.4).
 *
 * Since Phase C a dock panel's region is resolved state rather than a property
 * of its registration, so "open the scopes view" can no longer be spelled as
 * "select it in the region it registered into". Callers that know a view but
 * not its region go through here.
 *
 * Callers that legitimately know both — an extension opening its own fixed
 * view, a feature revealing a panel in a sidebar — can keep using
 * `hostViewRegistry.select`, which forwards dock regions to the same state.
 */
import type { DockRegion } from "./layout/layoutTypes";
import { useShellLayoutStore } from "./layout/useShellLayoutStore";
import { hostViewRegistry } from "./viewRegistry";

/** The dock region a panel resolves to right now, if it is placed in one. */
function getShellViewRegion(viewId: string): DockRegion | null {
  return useShellLayoutStore.getState().resolved.panelRegions[viewId] ?? null;
}

function isShellViewSelected(viewId: string): boolean {
  const region = getShellViewRegion(viewId);
  return (
    region !== null &&
    useShellLayoutStore.getState().resolved.regions[region].selectedViewId ===
      viewId
  );
}

/** Brings a view into sight wherever the user has put it. */
export function revealShellView(viewId: string): boolean {
  const region = getShellViewRegion(viewId);
  if (region === null) return false;
  return hostViewRegistry.select(region, viewId);
}

/**
 * Moves focus to a panel once the shell has re-rendered it in its new region.
 *
 * A move can unmount the control that started it — moving a region's last panel
 * closes the region — so the hand-off cannot live in that component's effects.
 * The microtask runs after the discrete update has committed, when the
 * destination tab exists.
 */
export function focusShellViewWhenPlaced(viewId: string): void {
  queueMicrotask(() => {
    const landed =
      document.getElementById(`shell-view-tab-${viewId}`) ??
      document.getElementById(`shell-view-panel-${viewId}`);
    landed?.focus();
  });
}

/** Hides a view by clearing the selection of whichever region shows it. */
export function dismissShellView(viewId: string): void {
  const region = getShellViewRegion(viewId);
  if (region === null || !isShellViewSelected(viewId)) return;
  hostViewRegistry.clearSelection(region);
}
