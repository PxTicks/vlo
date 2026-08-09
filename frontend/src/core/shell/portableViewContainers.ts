/**
 * Stable DOM hosts for portable panels (plan §3.6).
 *
 * A panel that can live in more than one region is rendered by whichever
 * component owns that region, so moving it would ordinarily unmount and
 * remount its subtree: local state resets, subscriptions churn, and any live
 * rendering context is rebuilt. Instead each portable panel owns one detached
 * container element for the lifetime of its registration. `ShellPortableViewHost`
 * renders the panel into that container through a portal from a position that
 * never moves, and the region mount adopts the container into its own DOM.
 *
 * Moving a panel is then a `Node.appendChild` of an element React does not own,
 * which preserves React state, effects, and canvas contents alike.
 */
const containers = new Map<string, HTMLElement>();

/** The container for a panel, created on first use by either side. */
export function acquirePortableViewContainer(viewId: string): HTMLElement {
  const existing = containers.get(viewId);
  if (existing) return existing;
  const element = document.createElement("div");
  element.dataset.shellPortableView = viewId;
  // Fills a flow region and lays out normally inside a scrolling one, so the
  // container adds no geometry of its own in either kind of dock.
  element.style.display = "flex";
  element.style.flexDirection = "column";
  element.style.flex = "1 1 auto";
  element.style.minWidth = "0";
  element.style.minHeight = "0";
  containers.set(viewId, element);
  return element;
}

export function peekPortableViewContainer(viewId: string): HTMLElement | null {
  return containers.get(viewId) ?? null;
}

/**
 * Drops a panel's container once nothing renders it any more. The element is
 * detached first, so a slot that outlives the host is left visibly empty rather
 * than holding a container nobody renders into.
 */
export function releasePortableViewContainer(viewId: string): void {
  const element = containers.get(viewId);
  if (!element) return;
  containers.delete(viewId);
  element.remove();
}
