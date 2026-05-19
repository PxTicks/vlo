import { Box } from "@mui/material";
import { ProjectTitle } from "../../features/project";
import { ProjectSettingsMenu } from "./ProjectSettingsMenu";

export function EditorTopBar() {
  return (
    <>
      <ProjectTitle />
      <Box sx={{ position: "absolute", right: 8 }}>
        <ProjectSettingsMenu />
      </Box>
    </>
  );
}
