import { Box, Tab, Tabs } from "@mui/material";
import { useShallow } from "zustand/react/shallow";
import { RegionCollapseButton } from "../../core/shell/components/RegionCollapseButton";
import { RegionSeparator } from "../../core/shell/components/RegionSeparator";
import { COLLAPSED_REGION_SIZE_PX } from "../../core/shell/layout/layoutTypes";
import { useShellLayoutStore } from "../../core/shell/layout/useShellLayoutStore";
import { ViewRegionMount } from "../../core/shell/ViewRegionMount";
import { ViewLayoutButton } from "../../core/shell/ViewLayoutButton";
import { useViewRegion } from "../../core/shell/useViewRegion";

/**
 * A column beside the player canvas, for tools that need to sit next to the
 * picture rather than in a sidebar. It renders nothing at all until a view is
 * registered here, so the player keeps the full width of its region by default.
 */
export function PlayerAsidePanel() {
  const { views, selectedViewId, selectView } = useViewRegion("player-aside");
  const region = useShellLayoutStore(
    useShallow((state) => state.resolved.regions["player-aside"]),
  );
  if (views.length === 0 || selectedViewId === null) return null;

  return (
    <Box
      data-testid="player-aside"
      id="shell-region-player-aside"
      tabIndex={-1}
      sx={{
        position: "relative",
        width: region.collapsed ? COLLAPSED_REGION_SIZE_PX : region.sizePx,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        bgcolor: "#121212",
        borderLeft: "1px solid #333",
        overflow: "hidden",
      }}
    >
      <Box
        aria-hidden={region.collapsed}
        sx={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          minHeight: 0,
          visibility: region.collapsed ? "hidden" : "visible",
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            borderBottom: "1px solid #27272a",
          }}
        >
          <Tabs
            value={selectedViewId}
            onChange={(_, value: string) => selectView(value)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ flex: 1, minHeight: 32 }}
          >
            {views.map((view) => (
              <Tab
                key={view.id}
                value={view.id}
                label={view.title}
                id={`shell-view-tab-${view.id}`}
                sx={{
                  minHeight: 32,
                  minWidth: 0,
                  px: 1.5,
                  fontSize: "0.7rem",
                }}
              />
            ))}
          </Tabs>
          <ViewLayoutButton
            region="player-aside"
            edge="right"
            allowSingleView
          />
          <RegionCollapseButton
            region="player-aside"
            label="Player aside"
          />
        </Box>
        <Box
          sx={{
            position: "relative",
            flexGrow: 1,
            minHeight: 0,
            overflow: "auto",
          }}
        >
          <ViewRegionMount
            region="player-aside"
            views={views}
            activeViewId={selectedViewId}
          />
        </Box>
      </Box>
      {region.collapsed ? (
        <Box sx={{ position: "absolute", left: 1, top: 1, zIndex: 30 }}>
          <RegionCollapseButton
            region="player-aside"
            label="Player aside"
          />
        </Box>
      ) : null}
      <RegionSeparator
        region="player-aside"
        label="Player aside"
        edge="left"
        controls="shell-region-player-aside"
        collapsedSizePx={COLLAPSED_REGION_SIZE_PX}
      />
    </Box>
  );
}
