import { Box } from "@mui/material";
import { ViewRegionMount } from "../../core/shell/ViewRegionMount";
import { useViewRegion } from "../../core/shell/useViewRegion";
import { useShellLayoutStore } from "../../core/shell/layout/useShellLayoutStore";
import { LeftSidebarPanel } from "./LeftSidebarPanel";
import { declareLeftSidebarHostViews } from "./leftSidebarHostViews";

declareLeftSidebarHostViews();

export function EditorLeftSidebar() {
  const { views, selectedViewId, selectView } =
    useViewRegion("left-sidebar");
  const collapsed = useShellLayoutStore(
    (state) => state.resolved.regions["left-sidebar"].collapsed,
  );

  const handleTabChange = (viewId: string): void => {
    selectView(viewId);
    if (
      useShellLayoutStore.getState().resolved.regions["left-sidebar"].collapsed
    ) {
      useShellLayoutStore
        .getState()
        .setRegionCollapsed("left-sidebar", false);
    }
  };

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
        onTabChange={handleTabChange}
        views={views}
      />
      <Box
        aria-hidden={collapsed}
        sx={{
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
          flexGrow: 1,
          overflow: "hidden",
          visibility: collapsed ? "hidden" : "visible",
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
