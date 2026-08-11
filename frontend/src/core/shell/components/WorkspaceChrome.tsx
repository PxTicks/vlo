import { useSyncExternalStore } from "react";
import CloseIcon from "@mui/icons-material/Close";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import SaveIcon from "@mui/icons-material/Save";
import {
  Alert,
  Box,
  Button,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import { useShellLayoutStore } from "../layout/useShellLayoutStore";
import { dedicatedWorkspaceController } from "../workspaces/DedicatedWorkspaceController";

export function WorkspaceChrome() {
  const snapshot = useSyncExternalStore(
    (listener) => dedicatedWorkspaceController.subscribe(listener),
    () => dedicatedWorkspaceController.getSnapshot(),
    () => dedicatedWorkspaceController.getSnapshot(),
  );
  const hasSavedOverride = useShellLayoutStore((state) => {
    const id = snapshot.active?.id;
    return id !== undefined && state.document.workspaceLayouts[id] !== undefined;
  });

  if (!snapshot.active) {
    return snapshot.lastError ? (
      <Alert
        severity="error"
        role="alert"
        onClose={() => dedicatedWorkspaceController.dismissError()}
        sx={{ position: "absolute", left: 8, py: 0, maxWidth: "45%" }}
      >
        {snapshot.lastError.message}
      </Alert>
    ) : null;
  }

  return (
    <Box
      data-testid="dedicated-workspace-chrome"
      sx={{
        position: "absolute",
        left: 8,
        display: "flex",
        alignItems: "center",
        gap: 0.75,
        minWidth: 0,
        maxWidth: "calc(50% - 16px)",
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="caption" color="primary.main" noWrap>
          {snapshot.active.title}
        </Typography>
        <Typography
          variant="caption"
          color={snapshot.lastError ? "error.main" : "text.secondary"}
          noWrap
          display="block"
          role={snapshot.lastError ? "alert" : undefined}
        >
          {snapshot.lastError?.message ?? snapshot.active.subjectLabel}
        </Typography>
      </Box>
      {snapshot.lastError ? (
        <Tooltip title="Dismiss workspace error">
          <IconButton
            size="small"
            aria-label="Dismiss workspace error"
            onClick={() => dedicatedWorkspaceController.dismissError()}
          >
            <CloseIcon fontSize="small" color="error" />
          </IconButton>
        </Tooltip>
      ) : null}
      <Tooltip title="Save this workspace layout">
        <span>
          <IconButton
            size="small"
            aria-label="Save workspace layout"
            disabled={snapshot.transition !== "idle"}
            onClick={() => dedicatedWorkspaceController.saveLayoutOverride()}
          >
            <SaveIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      {hasSavedOverride ? (
        <Tooltip title="Clear saved workspace layout">
          <span>
            <IconButton
              size="small"
              aria-label="Clear saved workspace layout"
              disabled={snapshot.transition !== "idle"}
              onClick={() => dedicatedWorkspaceController.clearLayoutOverride()}
            >
              <RestartAltIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      ) : null}
      <Button
        size="small"
        variant="outlined"
        color="inherit"
        startIcon={<CloseIcon />}
        disabled={snapshot.transition !== "idle"}
        onClick={() => void dedicatedWorkspaceController.exit()}
        sx={{ flexShrink: 0 }}
      >
        Exit
      </Button>
    </Box>
  );
}
