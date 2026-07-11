import { Box } from "@mui/material";
import { ProjectTitle } from "../../features/project";
import { ProjectSettingsMenu } from "./ProjectSettingsMenu";
import { IconButton } from "@mui/material";
import StackedLineChartIcon from "@mui/icons-material/StackedLineChart";
import { useScopesStore } from "../../features/scopes";

export function EditorTopBar() {
  const scopesOpen = useScopesStore((state) => state.open);
  const toggleScopes = useScopesStore((state) => state.toggle);
  return (
    <>
      <ProjectTitle />
      <Box sx={{ position: "absolute", right: 8 }}>
        <IconButton size="small" aria-label="Toggle video scopes" color={scopesOpen ? "primary" : "default"} onClick={toggleScopes}>
          <StackedLineChartIcon fontSize="small" />
        </IconButton>
        <ProjectSettingsMenu />
      </Box>
    </>
  );
}
