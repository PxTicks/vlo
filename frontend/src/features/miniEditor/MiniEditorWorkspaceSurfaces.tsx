import { Box, Stack } from "@mui/material";
import { dedicatedWorkspaceController } from "../../core/shell/workspaces";
import {
  MiniEditorActions,
  MiniEditorControls,
  MiniEditorPreview,
} from "./MiniEditorContent";
import { useMiniEditorStore } from "./useMiniEditorStore";

export function MiniEditorWorkspacePreviewSurface() {
  const title = useMiniEditorStore((state) => state.title);
  return (
    <Box
      role="region"
      aria-label={title}
      sx={{
        display: "flex",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        bgcolor: "#000",
      }}
    >
      <MiniEditorPreview fillStage />
    </Box>
  );
}

export function MiniEditorWorkspaceControlsSurface() {
  return (
    <Stack
      spacing={1.5}
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: "auto",
        px: 2,
        py: 1.5,
        bgcolor: "#161618",
      }}
    >
      <MiniEditorControls />
      <Stack
        direction="row"
        justifyContent="flex-end"
        spacing={1}
        sx={{ mt: "auto" }}
      >
        <MiniEditorActions
          onRequestClose={() => void dedicatedWorkspaceController.exit()}
        />
      </Stack>
    </Stack>
  );
}
