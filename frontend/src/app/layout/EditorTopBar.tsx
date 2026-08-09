import { Box, IconButton } from "@mui/material";
import StackedLineChartIcon from "@mui/icons-material/StackedLineChart";
import { ProjectTitle } from "../../features/project";
import { useShellLayoutStore } from "../../core/shell/layout/useShellLayoutStore";
import {
  dismissShellView,
  revealShellView,
} from "../../core/shell/shellViewPlacement";
import { ProjectSettingsMenu } from "./ProjectSettingsMenu";
import { declareBottomDockHostViews } from "./bottomDockHostViews";

// The toggle addresses the scopes view by ID, so its declaration must exist
// wherever the top bar renders — including on its own in a test.
declareBottomDockHostViews();

const SCOPES_VIEW_ID = "host.scopes";

export function EditorTopBar() {
  // Scopes are a shell view rather than a store of their own, and a portable
  // one: the toggle asks for the view by ID and lets the layout answer where it
  // currently lives, so moving it to the sidebar does not break this control.
  const scopesOpen = useShellLayoutStore((state) => {
    const region = state.resolved.panelRegions[SCOPES_VIEW_ID];
    return (
      region !== undefined &&
      state.resolved.regions[region].selectedViewId === SCOPES_VIEW_ID
    );
  });
  return (
    <>
      <ProjectTitle />
      <Box sx={{ position: "absolute", right: 8 }}>
        <IconButton
          size="small"
          aria-label="Toggle video scopes"
          color={scopesOpen ? "primary" : "default"}
          onClick={() => {
            if (scopesOpen) dismissShellView(SCOPES_VIEW_ID);
            else revealShellView(SCOPES_VIEW_ID);
          }}
        >
          <StackedLineChartIcon fontSize="small" />
        </IconButton>
        <ProjectSettingsMenu />
      </Box>
    </>
  );
}
