import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { hostContextKeys } from "./contextKeys";
import { DOCK_REGIONS } from "./layout/layoutTypes";
import { useShellLayoutStore } from "./layout/useShellLayoutStore";
import { acquirePortableViewContainer } from "./portableViewContainers";
import {
  hostViewRegistry,
  type HostViewRegion,
  type ShellViewEntry,
} from "./viewRegistry";

export interface ShellPortableViewHostProps {
  /**
   * Wraps each hosted panel. The host sits outside every region, so a portable
   * panel is no longer inside its region's error boundary; the shell layer that
   * owns those boundaries supplies an equivalent one here.
   */
  readonly wrap?: (view: ShellViewEntry, content: ReactNode) => ReactNode;
}

interface PortableViewMountProps {
  readonly entry: ShellViewEntry;
  readonly region: HostViewRegion;
  readonly active: boolean;
  readonly wrap: ShellPortableViewHostProps["wrap"];
}

/**
 * One portable panel, rendered from a position in the React tree that does not
 * change when the panel moves. Mount policy matches the in-region mount, so a
 * panel behaves the same whether or not it happens to be portable.
 */
function PortableViewMount({
  entry,
  region,
  active,
  wrap,
}: PortableViewMountProps) {
  const [hasBeenActive, setHasBeenActive] = useState(active);
  useEffect(() => {
    if (!active) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasBeenActive(true);
  }, [active]);
  if (!active && (!entry.keepMounted || (!entry.eager && !hasBeenActive))) {
    return null;
  }
  const Component = entry.component;
  const content = (
    <Component viewId={entry.id} region={region} active={active} />
  );
  // The container outlives this mount on purpose: it is reused if the same view
  // ID registers again, and discarding it here would hand a stale element to a
  // region slot whose effects have already run — including under StrictMode's
  // deliberate mount, unmount, remount cycle.
  return createPortal(
    wrap ? wrap(entry, content) : content,
    acquirePortableViewContainer(entry.id),
  );
}

/**
 * Renders every portable dock panel into its stable container. Mount this once,
 * above the regions, wherever dock panels can be shown.
 */
export function ShellPortableViewHost({ wrap }: ShellPortableViewHostProps) {
  useSyncExternalStore(
    (listener) => {
      const unsubscribeViews = hostViewRegistry.subscribe(listener);
      const unsubscribeContext = hostContextKeys.subscribe(listener);
      return () => {
        unsubscribeViews();
        unsubscribeContext();
      };
    },
    () => `${hostViewRegistry.getRevision()}:${hostContextKeys.getRevision()}`,
    () => `${hostViewRegistry.getRevision()}:${hostContextKeys.getRevision()}`,
  );
  const resolved = useShellLayoutStore((state) => state.resolved);

  // Keyed by view ID in one flat list, so a panel changing region reorders an
  // existing child instead of replacing it — which is the whole point of the
  // stable host. Hidden and unavailable panels are absent from
  // `orderedViewIds`, so they unmount exactly as an in-region mount would.
  const mounts: ReactNode[] = [];
  for (const region of DOCK_REGIONS) {
    const resolvedRegion = resolved.regions[region];
    for (const viewId of resolvedRegion.orderedViewIds) {
      const entry = hostViewRegistry.get(viewId);
      // A panel with one allowed region can never be reparented, so it keeps
      // the simpler in-region mount and never reaches the portal path.
      if (!entry || entry.allowedRegions.length < 2) continue;
      mounts.push(
        <PortableViewMount
          key={viewId}
          entry={entry}
          region={region}
          active={resolvedRegion.selectedViewId === viewId}
          wrap={wrap}
        />,
      );
    }
  }
  return mounts;
}
