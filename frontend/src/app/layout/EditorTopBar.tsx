import { Box, IconButton } from "@mui/material";
import StackedLineChartIcon from "@mui/icons-material/StackedLineChart";
import { ProjectTitle } from "../../features/project";
import { useViewRegion } from "../../core/shell/useViewRegion";
import { ProjectSettingsMenu } from "./ProjectSettingsMenu";
import { declareBottomDockHostViews } from "./bottomDockHostViews";

// The toggle addresses the scopes view by ID, so its declaration must exist
// wherever the top bar renders — including on its own in a test.
declareBottomDockHostViews();

const SCOPES_VIEW_ID = "host.scopes";

export function EditorTopBar() {
  // Scopes are a view in the bottom dock now, so the toggle is a region
  // selection rather than a store of its own — which is also what lets an
  // extension's own dock view be opened the same way.
  const { selectedViewId, selectView, closeRegion } = useViewRegion(
    "bottom-dock",
    { autoSelect: false },
  );
  const scopesOpen = selectedViewId === SCOPES_VIEW_ID;
  return (
    <>
      <ProjectTitle />
      <Box sx={{ position: "absolute", right: 8 }}>
        <IconButton
          size="small"
          aria-label="Toggle video scopes"
          color={scopesOpen ? "primary" : "default"}
          onClick={() => {
            if (scopesOpen) closeRegion();
            else selectView(SCOPES_VIEW_ID);
          }}
        >
          <StackedLineChartIcon fontSize="small" />
        </IconButton>
        <ProjectSettingsMenu />
      </Box>
    </>
  );
}
