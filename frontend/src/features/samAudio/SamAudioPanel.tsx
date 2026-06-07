import { memo } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  LinearProgress,
  TextField,
  Typography,
} from "@mui/material";
import { GraphicEq, CallSplit, Cancel } from "@mui/icons-material";
import { SamAudioModelDownloadOverlay } from "./components/SamAudioModelDownloadOverlay";
import { useSamAudioPanel } from "./hooks/useSamAudioPanel";

export const SamAudioPanel = memo(function SamAudioPanel() {
  const panel = useSamAudioPanel();
  const unavailable =
    panel.availability === "unavailable" || panel.availability === "idle";
  const disabled =
    panel.isBusy ||
    !panel.selectedAsset ||
    panel.availability !== "available";

  if (unavailable) {
    return (
      <Box sx={{ height: "100%", display: "flex" }}>
        <SamAudioModelDownloadOverlay
          onModelsInstalled={() => {
            void panel.refreshAvailability();
          }}
        />
      </Box>
    );
  }

  return (
    <Box
      data-testid="sam-audio-panel"
      sx={{ display: "flex", flexDirection: "column", gap: 2, p: 2 }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <GraphicEq sx={{ fontSize: 18, color: "primary.light" }} />
        <Typography variant="subtitle2">Split Audio</Typography>
      </Box>

      {!panel.selectedAsset ? (
        <Alert severity="info">Select an audio or video clip.</Alert>
      ) : null}
      {panel.spanPromptNeedsSelection ? (
        <Alert severity="info">
          Select a timeline range that overlaps the clip first.
        </Alert>
      ) : null}

      {panel.availability === "checking" ? (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
          <LinearProgress />
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Checking local SAM-Audio model files
          </Typography>
        </Box>
      ) : null}

      <TextField
        label="Text prompt"
        placeholder="man speaking"
        value={panel.promptText}
        onChange={(event) => panel.setPromptText(event.target.value)}
        size="small"
        fullWidth
        disabled={panel.isBusy}
      />

      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
        <FormControlLabel
          control={
            <Checkbox
              checked={panel.useSpanPrompt}
              onChange={(event) => panel.setUseSpanPrompt(event.target.checked)}
              disabled={panel.isBusy || !panel.canUseSpanPrompt}
              size="small"
            />
          }
          label="Use timeline span"
        />
        <FormControlLabel
          control={
            <Checkbox
              checked={panel.useVisualPrompt}
              onChange={(event) => panel.setUseVisualPrompt(event.target.checked)}
              disabled={
                panel.isBusy ||
                !panel.generatedSam2Mask ||
                panel.selectedAsset?.type !== "video"
              }
              size="small"
            />
          }
          label="Use SAM2 mask"
        />
      </Box>

      {panel.generatedSam2Mask ? (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          SAM2 mask: {panel.generatedSam2Mask.mask.name}
        </Typography>
      ) : null}

      {panel.isBusy ? (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
          <LinearProgress
            variant="determinate"
            value={Math.round(panel.progress * 100)}
          />
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {panel.statusMessage}
          </Typography>
        </Box>
      ) : null}

      {panel.error ? <Alert severity="error">{panel.error}</Alert> : null}
      {panel.availabilityError ? (
        <Alert severity="warning">{panel.availabilityError}</Alert>
      ) : null}

      <Box sx={{ display: "flex", gap: 1 }}>
        <Button
          variant="contained"
          startIcon={<CallSplit />}
          onClick={() => {
            void panel.startSeparation();
          }}
          disabled={disabled}
          sx={{ flex: 1, textTransform: "none" }}
        >
          Isolate Sound
        </Button>
        {panel.isBusy ? (
          <Button
            variant="outlined"
            color="error"
            startIcon={<Cancel />}
            onClick={() => {
              void panel.cancelSeparation();
            }}
            disabled={!panel.canCancel}
            sx={{ textTransform: "none" }}
          >
            Cancel
          </Button>
        ) : null}
      </Box>
    </Box>
  );
});
