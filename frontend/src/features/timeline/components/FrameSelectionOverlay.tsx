import { useCallback } from "react";
import { Paper, Button, Typography, Box } from "@mui/material";
import { useExtractStore } from "../../player/useExtractStore";

export function FrameSelectionOverlay() {
  const frameSelectionMode = useExtractStore((s) => s.frameSelectionMode);
  const exitFrameSelectionMode = useExtractStore(
    (s) => s.exitFrameSelectionMode,
  );
  const onConfirmSelection = useExtractStore((s) => s.onConfirmSelection);
  const setOnConfirmSelection = useExtractStore((s) => s.setOnConfirmSelection);

  const handleCancel = useCallback(() => {
    exitFrameSelectionMode();
    setOnConfirmSelection(null);
  }, [exitFrameSelectionMode, setOnConfirmSelection]);

  const handleConfirm = useCallback(() => {
    if (onConfirmSelection) onConfirmSelection();
  }, [onConfirmSelection]);

  if (!frameSelectionMode) return null;

  return (
    <Paper
      onPointerDown={(e) => {
        // Prevent clicking through the overlay into the timeline
        e.stopPropagation();
      }}
      sx={{
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1000,
        bgcolor: "#222",
        border: "1px solid #444",
        px: 2,
        py: 1,
        display: "flex",
        gap: 1.5,
        alignItems: "center",
        borderRadius: 2,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", mr: 2 }}>
        <Typography variant="body2" sx={{ color: "#aaa" }}>
          Position playhead to extract frame
        </Typography>
      </Box>

      <Button
        size="small"
        color="inherit"
        onClick={handleCancel}
        sx={{ color: "#aaa" }}
      >
        Cancel
      </Button>
      <Button size="small" variant="contained" onClick={handleConfirm}>
        Extract Current Frame
      </Button>
    </Paper>
  );
}
