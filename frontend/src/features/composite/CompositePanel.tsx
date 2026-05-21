import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import AddBoxIcon from "@mui/icons-material/AddBox";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import LayersIcon from "@mui/icons-material/Layers";
import { playbackClock } from "../player/services/PlaybackClock";
import { useExtractStore } from "../player/useExtractStore";
import {
  createTimelineSelection,
  getDefaultSelectionEnd,
  useTimelineSelectionStore,
} from "../timelineSelection";
import { groupSelectionIntoComposite } from "./services/groupSelectionIntoComposite";
import { useCompositeTimelineStore } from "./useCompositeTimelineStore";

export function CompositePanel() {
  const [isCreatingFromSelection, setIsCreatingFromSelection] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  const subtimelineDepth = useCompositeTimelineStore((state) => state.stack.length);
  const isSubtimeline = subtimelineDepth > 0;
  const isCompositeBusy = useCompositeTimelineStore((state) => state.isBusy);
  const selectionMode = useTimelineSelectionStore((state) => state.selectionMode);
  const lastError = useCompositeTimelineStore((state) => state.lastError);
  const clearLastError = useCompositeTimelineStore(
    (state) => state.clearLastError,
  );
  const startBlankSubtimeline = useCompositeTimelineStore(
    (state) => state.startBlankSubtimeline,
  );
  const exitToMainTimeline = useCompositeTimelineStore(
    (state) => state.exitToMainTimeline,
  );

  const handleConfirmCompositeSelection = async () => {
    if (isCreatingFromSelection) return;

    const {
      selectionStartTick,
      selectionEndTick,
      exitSelectionMode,
    } = useTimelineSelectionStore.getState();
    const selection = createTimelineSelection(selectionStartTick, selectionEndTick);
    exitSelectionMode();
    useExtractStore.getState().setOnConfirmSelection(null);

    setSelectionError(null);
    setIsCreatingFromSelection(true);
    try {
      await groupSelectionIntoComposite(selection);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to create a composite clip from the selection.";
      setSelectionError(message);
      console.error("Failed to create composite from selection", error);
    } finally {
      setIsCreatingFromSelection(false);
    }
  };

  const handleCreateFromSelection = () => {
    const currentTime = playbackClock.time;
    const safeEnd = getDefaultSelectionEnd(currentTime);
    useExtractStore.getState().setOnConfirmSelection(() => {
      void handleConfirmCompositeSelection();
    });
    useTimelineSelectionStore.getState().enterSelectionMode(
      currentTime,
      safeEnd,
      {
        message: "Choose the timeline range to turn into a composite clip.",
      },
    );
  };

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        p: 2,
        minWidth: 0,
        color: "#f5f5f5",
      }}
      data-testid="composite-panel"
    >
      {isSubtimeline ? (
        <>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            Editing subtimeline
          </Typography>
          <Typography variant="body2" sx={{ color: "#aeb4bd" }}>
            This timeline will render back into its composite clip.
          </Typography>
          <Button
            variant="contained"
            startIcon={
              isCompositeBusy ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <ArrowBackIcon fontSize="small" />
              )
            }
            disabled={isCompositeBusy}
            onClick={() => {
              void exitToMainTimeline();
            }}
            data-testid="composite-panel-back-to-main"
            sx={{ alignSelf: "flex-start" }}
          >
            Back to main timeline
          </Button>
          {lastError ? (
            <Alert severity="error" onClose={clearLastError}>
              {lastError}
            </Alert>
          ) : null}
        </>
      ) : (
        <>
          <Stack direction="row" spacing={2}>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <Tooltip title="Add scene">
                <IconButton
                  aria-label="Add scene"
                  data-testid="composite-add-scene"
                  onClick={startBlankSubtimeline}
                  sx={{
                    width: 64,
                    height: 64,
                    border: "1px solid #343a40",
                    borderRadius: 1,
                    color: "#f5f5f5",
                    bgcolor: "#181b20",
                    "&:hover": { bgcolor: "#20252c" },
                  }}
                >
                  <AddBoxIcon />
                </IconButton>
              </Tooltip>
              <Typography variant="caption" sx={{ color: "#aeb4bd" }}>
                Add scene
              </Typography>
            </Box>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <Tooltip title="Create from selection">
                <span>
                  <IconButton
                    aria-label="Create from selection"
                    data-testid="composite-create-from-selection"
                    disabled={selectionMode || isCreatingFromSelection}
                    onClick={() => {
                      handleCreateFromSelection();
                    }}
                    sx={{
                      width: 64,
                      height: 64,
                      border: "1px solid #343a40",
                      borderRadius: 1,
                      color: "#f5f5f5",
                      bgcolor: "#181b20",
                      "&:hover": { bgcolor: "#20252c" },
                      "&.Mui-disabled": {
                        color: "#6b7280",
                        bgcolor: "#121417",
                      },
                    }}
                  >
                    {isCreatingFromSelection ? (
                      <CircularProgress size={20} color="inherit" />
                    ) : (
                      <LayersIcon />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
              <Typography variant="caption" sx={{ color: "#aeb4bd" }}>
                Create from selection
              </Typography>
            </Box>
          </Stack>
          {selectionError ? (
            <Alert severity="error" onClose={() => setSelectionError(null)}>
              {selectionError}
            </Alert>
          ) : null}
        </>
      )}
    </Box>
  );
}
