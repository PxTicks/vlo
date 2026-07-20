import { useState, memo, useEffect } from "react";
import {
  Box,
  IconButton,
  Tab,
  Tabs,
  Tooltip,
} from "@mui/material";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import { AppMenu } from "../../core/shell/AppMenu";
import {
  useSelectedTimelineClipIds,
  useSelectedTimelineTransitionId,
  useTimelineClip,
} from "../../features/timeline/api";
import { useMaskViewStore } from "../../features/masks";
import { ViewRegionMount } from "../../core/shell/ViewRegionMount";
import { useViewRegion } from "../../core/shell/useViewRegion";
import { ViewLayoutButton } from "../../core/shell/ViewLayoutButton";
import { declareRightSidebarHostViews } from "./rightSidebarHostViews";

declareRightSidebarHostViews();

function RightSidebarPanelComponent() {
  const selectedClipIds = useSelectedTimelineClipIds();
  const selectedTransitionId = useSelectedTimelineTransitionId();
  const hasTransitionSelection = selectedTransitionId !== null;
  const hasClipSelection = selectedClipIds.length > 0;
  const primarySelectedClip = useTimelineClip(selectedClipIds[0]);
  const isAdjustmentSelected = primarySelectedClip?.type === "adjustment";
  const selectionMode = hasTransitionSelection
    ? "transition"
    : !hasClipSelection
      ? "none"
      : isAdjustmentSelected
        ? "adjustment"
        : "clip";
  const [workspaceMenuAnchor, setWorkspaceMenuAnchor] =
    useState<HTMLElement | null>(null);
  const { views, selectedViewId, selectView } =
    useViewRegion("right-sidebar");
  const selectedEntry = views.find((view) => view.id === selectedViewId);
  const coreViews = views.filter((view) => view.source === "host");
  const extensionViews = views.filter((view) => view.source === "extension");

  // On selection-kind changes, snap to the matching editor: Transition for a
  // transition, Adjust for a clip, and Generate when selection is cleared.
  // Selection changes do not displace an explicitly selected extension view.
  useEffect(() => {
    if (selectedEntry?.source === "extension") return;
    const preferred =
      selectionMode === "transition"
        ? "host.transition"
        : selectionMode === "none"
          ? "host.generate"
          : "host.adjust";
    selectView(preferred);
  }, [selectView, selectedEntry?.source, selectionMode]);

  useEffect(() => {
    const { setMaskTabActive } = useMaskViewStore.getState();
    setMaskTabActive(selectedViewId === "host.mask");
  }, [selectedViewId]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "stretch",
          borderBottom: "1px solid #333",
        }}
      >
        <Tabs
          data-testid="right-sidebar-tabs"
          value={selectedEntry?.source === "host" ? selectedViewId : false}
          onChange={(_, value: string) => selectView(value)}
          textColor="primary"
          indicatorColor="primary"
          variant="fullWidth"
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 36,
            "& .MuiTab-root": {
              minWidth: 0,
              minHeight: 36,
              px: 0.75,
              py: 0.5,
              fontSize: "0.72rem",
              lineHeight: 1.2,
              textTransform: "none",
            },
          }}
        >
          {coreViews.map((view) => (
            <Tab
              key={view.id}
              id={`shell-view-tab-${view.id}`}
              aria-controls={`shell-view-panel-${view.id}`}
              data-testid={`right-sidebar-tab-${view.id.replace(/^host\./, "")}`}
              label={view.title}
              value={view.id}
            />
          ))}
        </Tabs>
        {extensionViews.length > 0 ? (
          <>
            <Tooltip
              title={
                selectedEntry?.source === "extension"
                  ? selectedEntry.title
                  : "More panels"
              }
            >
              <IconButton
                data-testid="right-sidebar-workspace-menu-button"
                aria-label="More panels"
                aria-haspopup="menu"
                aria-expanded={workspaceMenuAnchor !== null}
                aria-controls={
                  workspaceMenuAnchor === null
                    ? undefined
                    : "right-sidebar-workspace-menu"
                }
                aria-pressed={selectedEntry?.source === "extension"}
                size="small"
                onClick={(event) => setWorkspaceMenuAnchor(event.currentTarget)}
                sx={{
                  width: 32,
                  minHeight: 36,
                  flexShrink: 0,
                  borderLeft: "1px solid #333",
                  borderRadius: 0,
                  color:
                    selectedEntry?.source !== "extension"
                      ? "text.secondary"
                      : "primary.main",
                  bgcolor:
                    selectedEntry?.source !== "extension"
                      ? "transparent"
                      : "action.selected",
                }}
              >
                <ArrowDropDownIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <AppMenu
              menuId="app.view.select"
              subject={{
                slot: "app.view.select",
                region: {
                  id: "right-sidebar",
                  selectedViewId,
                },
              }}
              items={extensionViews.map((view, index) => ({
                kind: "action",
                id: `view-${view.id}`,
                label: view.title,
                group: "1_views",
                order: index,
                selected: view.id === selectedViewId,
                testId: `right-sidebar-workspace-menu-item-${view.id}`,
                run: () => selectView(view.id),
              }))}
              open={workspaceMenuAnchor !== null}
              onClose={() => setWorkspaceMenuAnchor(null)}
              anchorEl={workspaceMenuAnchor}
              anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
              transformOrigin={{ vertical: "top", horizontal: "right" }}
              slotProps={{ paper: { sx: { maxHeight: 320 } } }}
              id="right-sidebar-workspace-menu"
            />
          </>
        ) : null}
        <ViewLayoutButton region="right-sidebar" edge="right" />
      </Box>
      <Box sx={{ flexGrow: 1, position: "relative", overflow: "hidden" }}>
        <ViewRegionMount
          region="right-sidebar"
          views={views}
          activeViewId={selectedViewId}
          layout="absolute"
          getTabId={(entry) =>
            entry.source === "host" ? `shell-view-tab-${entry.id}` : undefined
          }
        />
      </Box>
    </Box>
  );
}

export const RightSidebarPanel = memo(RightSidebarPanelComponent);
