import { useLayoutEffect, useRef } from "react";
import { Box, IconButton, Tab, Tabs, Tooltip } from "@mui/material";
import { useShallow } from "zustand/react/shallow";
import CloseIcon from "@mui/icons-material/Close";
import { RegionCollapseButton } from "../../core/shell/components/RegionCollapseButton";
import { RegionSeparator } from "../../core/shell/components/RegionSeparator";
import { COLLAPSED_REGION_SIZE_PX } from "../../core/shell/layout/layoutTypes";
import { useShellLayoutStore } from "../../core/shell/layout/useShellLayoutStore";
import { ViewRegionMount } from "../../core/shell/ViewRegionMount";
import { ViewLayoutButton } from "../../core/shell/ViewLayoutButton";
import { useViewRegion } from "../../core/shell/useViewRegion";
import { declareBottomDockHostViews } from "./bottomDockHostViews";

declareBottomDockHostViews();

/**
 * The dock between the player and the timeline. Unlike the sidebars it is
 * user-toggled: nothing is selected until someone opens a view, and an empty
 * selection renders no dock at all, so an editor nobody has opened scopes in is
 * laid out exactly as it was before the region existed.
 */
export function EditorBottomDock() {
  const { views, selectedViewId, selectView, closeRegion } = useViewRegion(
    "bottom-dock",
    { autoSelect: false },
  );
  const region = useShellLayoutStore(
    useShallow((state) => state.resolved.regions["bottom-dock"]),
  );
  const previousSelectionRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (
      previousSelectionRef.current === null &&
      selectedViewId !== null &&
      region.collapsed
    ) {
      useShellLayoutStore
        .getState()
        .setRegionCollapsed("bottom-dock", false);
    }
    previousSelectionRef.current = selectedViewId;
  }, [region.collapsed, selectedViewId]);
  if (selectedViewId === null || views.length === 0) return null;

  return (
    <Box
      data-testid="editor-bottom-dock"
      id="shell-region-bottom-dock"
      sx={{
        position: "relative",
        height: region.collapsed ? COLLAPSED_REGION_SIZE_PX : region.sizePx,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        bgcolor: "#09090b",
        borderTop: "1px solid #3f3f46",
        maxHeight: "60%",
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
            region="bottom-dock"
            edge="right"
            allowSingleView
          />
          <RegionCollapseButton
            region="bottom-dock"
            label="Bottom dock"
          />
          <Tooltip title="Close dock">
            <IconButton
              size="small"
              aria-label="Close dock"
              onClick={closeRegion}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
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
            region="bottom-dock"
            views={views}
            activeViewId={selectedViewId}
          />
        </Box>
      </Box>
      {region.collapsed ? (
        <Box sx={{ position: "absolute", right: 1, top: 0, zIndex: 30 }}>
          <RegionCollapseButton
            region="bottom-dock"
            label="Bottom dock"
          />
        </Box>
      ) : null}
      <RegionSeparator
        region="bottom-dock"
        label="Bottom dock"
        edge="top"
        controls="shell-region-bottom-dock"
      />
    </Box>
  );
}
