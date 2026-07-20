import { useEffect, useState } from "react";
import { Box } from "@mui/material";
import type { HostViewRegion, ShellViewEntry } from "./viewRegistry";

interface ViewMountProps {
  readonly entry: ShellViewEntry;
  readonly region: HostViewRegion;
  readonly active: boolean;
  readonly layout: "flow" | "absolute";
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
      sx={
        layout === "absolute"
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
              flexGrow: 1,
              overflow: "hidden",
            }
      }
    >
      <Component viewId={entry.id} region={region} active={active} />
    </Box>
  );
}

export interface ViewRegionMountProps {
  readonly region: HostViewRegion;
  readonly views: readonly ShellViewEntry[];
  readonly activeViewId: string | null;
  readonly layout?: "flow" | "absolute";
  readonly getTabId?: (entry: ShellViewEntry) => string | undefined;
}

export function ViewRegionMount({
  region,
  views,
  activeViewId,
  layout = "flow",
  getTabId,
}: ViewRegionMountProps) {
  return views.map((entry) => (
    <ViewMount
      key={entry.id}
      entry={entry}
      region={region}
      active={entry.id === activeViewId}
      layout={layout}
      tabId={getTabId ? getTabId(entry) : `shell-view-tab-${entry.id}`}
    />
  ));
}
