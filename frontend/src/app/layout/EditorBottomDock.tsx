import { Box, IconButton, Tab, Tabs, Tooltip } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
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
  if (selectedViewId === null || views.length === 0) return null;

  return (
    <Box
      data-testid="editor-bottom-dock"
      sx={{
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        bgcolor: "#09090b",
        borderTop: "1px solid #3f3f46",
        maxHeight: "60%",
        overflow: "hidden",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", borderBottom: "1px solid #27272a" }}>
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
              sx={{ minHeight: 32, minWidth: 0, px: 1.5, fontSize: "0.7rem" }}
            />
          ))}
        </Tabs>
        <ViewLayoutButton region="bottom-dock" edge="right" />
        <Tooltip title="Close dock">
          <IconButton size="small" aria-label="Close dock" onClick={closeRegion}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <Box sx={{ position: "relative", flexGrow: 1, minHeight: 0, overflow: "auto" }}>
        <ViewRegionMount
          region="bottom-dock"
          views={views}
          activeViewId={selectedViewId}
        />
      </Box>
    </Box>
  );
}
