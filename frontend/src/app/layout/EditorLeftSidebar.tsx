import { Box } from "@mui/material";
import { ViewRegionMount } from "../../core/shell/ViewRegionMount";
import { useViewRegion } from "../../core/shell/useViewRegion";
import { LeftSidebarPanel } from "./LeftSidebarPanel";
import { declareLeftSidebarHostViews } from "./leftSidebarHostViews";

declareLeftSidebarHostViews();

export function EditorLeftSidebar() {
  const { views, selectedViewId, selectView } =
    useViewRegion("left-sidebar");

  return (
    <Box
      sx={{
        display: "flex",
        minWidth: 0,
        minHeight: 0,
        flexGrow: 1,
        height: "100%",
        overflow: "hidden",
      }}
    >
      <LeftSidebarPanel
        activeTab={selectedViewId}
        onTabChange={selectView}
        views={views}
      />
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
          flexGrow: 1,
          overflow: "hidden",
        }}
      >
        <ViewRegionMount
          region="left-sidebar"
          views={views}
          activeViewId={selectedViewId}
        />
      </Box>
    </Box>
  );
}
