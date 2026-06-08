import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { playbackClock } from "../player/services/PlaybackClock";
import { useExtractStore } from "../player/useExtractStore";
import {
  createTimelineSelection,
  getDefaultSelectionEnd,
  useTimelineSelectionStore,
} from "../timelineSelection";
import { groupSelectionIntoComposite } from "./services/groupSelectionIntoComposite";
import { useCompositeTimelineStore } from "./useCompositeTimelineStore";
import { CompositeBrowser } from "./CompositeBrowser";

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
  const startBlankCompositeAsset = useCompositeTimelineStore(
    (state) => state.startBlankCompositeAsset,
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
        minHeight: 0,
        height: "100%",
        overflowY: "auto",
        color: "#f5f5f5",
      }}
      data-testid="composite-panel"
    >
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: 0.5,
          bgcolor: "rgba(255, 193, 7, 0.06)",
          border: "1px solid rgba(255, 193, 7, 0.15)",
          borderRadius: 1,
          p: 1.25,
        }}
      >
        <Typography
          variant="caption"
          sx={{
            color: "#ffb020",
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 0.5,
          }}
        >
          ⚠️ Experimental Feature
        </Typography>
        <Typography variant="caption" sx={{ color: "#aeb4bd", lineHeight: 1.3 }}>
          Scenes and subtimelines are under development.
        </Typography>
      </Box>

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
        <CompositeBrowser
          isCreatingFromSelection={isCreatingFromSelection || selectionMode}
          selectionError={selectionError}
          onCreateBlank={startBlankCompositeAsset}
          onCreateFromSelection={handleCreateFromSelection}
          onClearSelectionError={() => setSelectionError(null)}
        />
      )}

    </Box>
  );
}
