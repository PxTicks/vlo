import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, type SxProps, type Theme } from "@mui/material";
import { acquirePortableViewContainer } from "./portableViewContainers";
import type { HostViewRegion, ShellViewEntry } from "./viewRegistry";

type ViewMountLayout = "flow" | "absolute";

/**
 * The panel frame is the region's, not the view's: it carries the tab-panel
 * semantics and decides how an inactive view is kept out of the way. Portable
 * panels reuse it so a move cannot change how a panel is presented.
 */
function panelSx(layout: ViewMountLayout, active: boolean): SxProps<Theme> {
  return layout === "absolute"
    ? {
        position: "absolute",
        inset: 0,
        height: "100%",
        overflowY: "auto",
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
      }
    : {
        display: active ? "flex" : "none",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        flexGrow: 1,
        overflow: "hidden",
      };
}

interface ViewMountProps {
  readonly entry: ShellViewEntry;
  readonly region: HostViewRegion;
  readonly active: boolean;
  readonly layout: ViewMountLayout;
  readonly tabId: string | undefined;
}

function ViewMount({ entry, region, active, layout, tabId }: ViewMountProps) {
  const [hasBeenActive, setHasBeenActive] = useState(active);
  useEffect(() => {
    if (!active) return;
    // Trusted views mount lazily, then stay alive across tab switches.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasBeenActive(true);
  }, [active]);
  if (
    !active &&
    (!entry.keepMounted || (!entry.eager && !hasBeenActive))
  ) {
    return null;
  }
  const Component = entry.component;
  return (
    <Box
      id={`shell-view-panel-${entry.id}`}
      role="tabpanel"
      aria-label={entry.title}
      aria-labelledby={tabId}
      aria-hidden={!active}
      sx={panelSx(layout, active)}
    >
      <Component viewId={entry.id} region={region} active={active} />
    </Box>
  );
}

/**
 * The region's end of a portable panel: an empty frame that adopts the panel's
 * stable container. `ShellPortableViewHost` renders the panel itself, so moving
 * it between regions moves this element rather than rebuilding the subtree.
 */
function PortableViewSlot({
  entry,
  active,
  layout,
  tabId,
}: Omit<ViewMountProps, "region">) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const container = acquirePortableViewContainer(entry.id);
    slot.appendChild(container);
    return () => {
      // A move appends the container to its new slot first or last depending on
      // commit order, so only reclaim it if this slot still owns it.
      if (container.parentElement === slot) container.remove();
    };
  }, [entry.id]);

  return (
    <Box
      ref={slotRef}
      id={`shell-view-panel-${entry.id}`}
      role="tabpanel"
      aria-label={entry.title}
      aria-labelledby={tabId}
      aria-hidden={!active}
      data-portable-view-slot={entry.id}
      sx={panelSx(layout, active)}
    />
  );
}

export interface ViewRegionMountProps {
  readonly region: HostViewRegion;
  readonly views: readonly ShellViewEntry[];
  readonly activeViewId: string | null;
  readonly layout?: ViewMountLayout;
  readonly getTabId?: (entry: ShellViewEntry) => string | undefined;
}

export function ViewRegionMount({
  region,
  views,
  activeViewId,
  layout = "flow",
  getTabId,
}: ViewRegionMountProps) {
  return views.map((entry) => {
    const active = entry.id === activeViewId;
    const tabId = getTabId ? getTabId(entry) : `shell-view-tab-${entry.id}`;
    return entry.allowedRegions.length > 1 ? (
      <PortableViewSlot
        key={entry.id}
        entry={entry}
        active={active}
        layout={layout}
        tabId={tabId}
      />
    ) : (
      <ViewMount
        key={entry.id}
        entry={entry}
        region={region}
        active={active}
        layout={layout}
        tabId={tabId}
      />
    );
  });
}
