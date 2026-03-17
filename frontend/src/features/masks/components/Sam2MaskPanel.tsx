import { memo, useMemo } from "react";
import { Box, Button, Typography, Divider, ButtonGroup } from "@mui/material";
import type { ClipMaskMode, ClipMaskPoint } from "../../../types/TimelineTypes";

const connectedButtonSx = {
  textTransform: "none",
  borderColor: "#2f333a",
  bgcolor: "#4a4f57",
  color: "#f2f3f5",
  "&:hover": {
    bgcolor: "#5a606b",
    borderColor: "#2f333a",
  },
  "&.Mui-disabled": {
    bgcolor: "#3a3f47",
    color: "#8a8f98",
    borderColor: "#2f333a",
  },
};

const selectedConnectedButtonSx = {
  ...connectedButtonSx,
  bgcolor: "#6b7280",
  color: "#ffffff",
  "&:hover": {
    bgcolor: "#7a8292",
  },
};

interface Sam2MaskPanelProps {
  maskMode: ClipMaskMode;
  maskInverted: boolean;
  maskLabel: string;
  points: ClipMaskPoint[];
  currentFramePointsCount: number;
  isSam2Available: boolean;
  isSam2Checking: boolean;
  sam2AvailabilityError: string | null;
  onClearPoints: () => void;
  onClearCurrentFramePoints: () => void;
  onGenerateFramePreview: () => void | Promise<void>;
  isFrameGenerating: boolean;
  framePreviewError: string | null;
  onGenerateMask: () => void | Promise<void>;
  isGenerating: boolean;
  generateError: string | null;
  isDirty: boolean;
  hasMaskAsset: boolean;
  onSetMaskMode: (mode: ClipMaskMode) => void;
  onSetMaskInverted: (inverted: boolean) => void;
}

export const Sam2MaskPanel = memo(function Sam2MaskPanel({
  maskMode,
  maskInverted,
  maskLabel,
  points,
  currentFramePointsCount,
  isSam2Available,
  isSam2Checking,
  sam2AvailabilityError,
  onClearPoints,
  onClearCurrentFramePoints,
  onGenerateFramePreview,
  isFrameGenerating,
  framePreviewError,
  onGenerateMask,
  isGenerating,
  generateError,
  isDirty,
  hasMaskAsset,
  onSetMaskMode,
  onSetMaskInverted,
}: Sam2MaskPanelProps) {
  const positiveCount = useMemo(
    () => points.filter((p) => p.label === 1).length,
    [points],
  );
  const negativeCount = useMemo(
    () => points.filter((p) => p.label === 0).length,
    [points],
  );

  const showRegenerate = hasMaskAsset && isDirty;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {/* Header */}
      <Box sx={{ px: 2 }}>
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "inline-block", mr: 1 }}
        >
          {maskLabel}
        </Typography>
        <Typography
          variant="caption"
          sx={{ color: "text.disabled", display: "inline-block" }}
        >
          — Type: SAM2
        </Typography>
        <Typography
          variant="caption"
          sx={{
            color: isSam2Available
              ? "#22c55e"
              : isSam2Checking
                ? "#f59e0b"
                : "#ef4444",
            display: "block",
            mt: 0.5,
          }}
        >
          {isSam2Available
            ? "SAM2 available"
            : isSam2Checking
              ? "Checking SAM2 availability..."
              : sam2AvailabilityError ??
                "SAM2 is unavailable. Install or configure SAM2 models first."}
        </Typography>
      </Box>

      {/* ── Points Editor ── */}
      <Box sx={{ px: 2 }}>
        <Divider sx={{ borderColor: "#2a2d33", mb: 1.5 }} />
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block", mb: 1, fontWeight: 600 }}
        >
          Points Editor
        </Typography>
        <Typography
          variant="caption"
          sx={{ color: "text.disabled", display: "block", mb: 1 }}
        >
          Left click what you want to select, right click what you want to omit.
          Click a point to remove it.
        </Typography>
        <Box sx={{ display: "flex", gap: 2, mb: 0.5 }}>
          <Typography variant="body2" sx={{ color: "#22c55e" }}>
            +{positiveCount}
          </Typography>
          <Typography variant="body2" sx={{ color: "#ef4444" }}>
            −{negativeCount}
          </Typography>
        </Box>
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block", mb: 0.5 }}
        >
          Current frame: {currentFramePointsCount} point
          {currentFramePointsCount !== 1 ? "s" : ""} · Total: {points.length}{" "}
          point{points.length !== 1 ? "s" : ""}
        </Typography>
        <Box sx={{ display: "flex", gap: 1 }}>
          {currentFramePointsCount > 0 && (
            <Button
              variant="text"
              size="small"
              onClick={onClearCurrentFramePoints}
              sx={{
                textTransform: "none",
                color: "text.secondary",
                p: 0,
                minWidth: 0,
                "&:hover": { color: "#ef4444" },
              }}
            >
              Clear Frame Points
            </Button>
          )}
          {points.length > 0 && (
            <Button
              variant="text"
              size="small"
              onClick={onClearPoints}
              sx={{
                textTransform: "none",
                color: "text.secondary",
                p: 0,
                minWidth: 0,
                "&:hover": { color: "#ef4444" },
              }}
            >
              Clear All Points
            </Button>
          )}
        </Box>
      </Box>

      {/* ── Generation ── */}
      <Box sx={{ px: 2 }}>
        <Divider sx={{ borderColor: "#2a2d33", mb: 1.5 }} />
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block", mb: 1, fontWeight: 600 }}
        >
          Generation
        </Typography>

        <Button
          variant="outlined"
          size="small"
          onClick={() => {
            if (maskMode !== "preview") {
              onSetMaskMode("preview");
            }
            void onGenerateFramePreview();
          }}
          disabled={!isSam2Available || isFrameGenerating || points.length === 0}
          sx={{
            textTransform: "none",
            width: "100%",
            borderColor: "#2f333a",
            color: "#f2f3f5",
            mb: 0.5,
            "&:hover": {
              borderColor: "#4b5563",
              bgcolor: "#1f2937",
            },
          }}
        >
          {isFrameGenerating
            ? "Generating Frame Preview..."
            : "Generate Current Frame Preview"}
        </Button>
        {framePreviewError && (
          <Typography
            variant="caption"
            sx={{ display: "block", color: "#ef4444", mb: 0.5 }}
          >
            Preview error: {framePreviewError}
          </Typography>
        )}

        <Button
          variant="contained"
          size="small"
          onClick={() => {
            void onGenerateMask();
          }}
          disabled={!isSam2Available || isGenerating || points.length === 0}
          sx={{
            textTransform: "none",
            width: "100%",
            mt: 0.5,
            bgcolor: isGenerating
              ? "#4b5563"
              : showRegenerate
                ? "#d97706"
                : "#2563eb",
            "&:hover": {
              bgcolor: isGenerating
                ? "#4b5563"
                : showRegenerate
                  ? "#b45309"
                  : "#1d4ed8",
            },
          }}
        >
          {isGenerating
            ? "Generating Mask Video..."
            : showRegenerate
              ? "Regenerate Mask Video"
              : "Generate Mask Video"}
        </Button>
        <Typography
          variant="caption"
          sx={{
            mt: 0.5,
            display: "block",
            color: generateError
              ? "#ef4444"
              : isGenerating
                ? "#f59e0b"
                : isDirty
                  ? "#f59e0b"
                  : hasMaskAsset
                    ? "#22c55e"
                    : "#9ca3af",
          }}
        >
          {generateError
            ? `Error: ${generateError}`
            : !isSam2Available
              ? sam2AvailabilityError ??
                "SAM2 is unavailable. Install or configure SAM2 models first."
            : isGenerating
              ? "Generating"
              : points.length === 0
                ? "Add points to generate."
                : isDirty
                  ? hasMaskAsset
                    ? "Out of date"
                    : "Not yet generated"
                  : "Up to date"}
        </Typography>
      </Box>

      {/* ── Mask Settings ── */}
      <Box sx={{ px: 2, pb: 2 }}>
        <Divider sx={{ borderColor: "#2a2d33", mb: 2 }} />

        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block", mb: 1 }}
        >
          Mode
        </Typography>
        <ButtonGroup
          variant="contained"
          disableElevation
          size="small"
          fullWidth
          sx={{ mb: 1 }}
        >
          <Button
            onClick={() => onSetMaskMode("apply")}
            sx={
              maskMode === "apply"
                ? selectedConnectedButtonSx
                : connectedButtonSx
            }
          >
            Apply
          </Button>
          <Button
            onClick={() => onSetMaskMode("preview")}
            sx={
              maskMode === "preview"
                ? selectedConnectedButtonSx
                : connectedButtonSx
            }
          >
            Preview
          </Button>
          <Button
            onClick={() => onSetMaskMode("off")}
            sx={
              maskMode === "off" ? selectedConnectedButtonSx : connectedButtonSx
            }
          >
            Off
          </Button>
        </ButtonGroup>

        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block", mb: 1 }}
        >
          Inversion
        </Typography>
        <ButtonGroup
          variant="contained"
          disableElevation
          size="small"
          fullWidth
          sx={{ mb: 1 }}
        >
          <Button
            onClick={() => onSetMaskInverted(false)}
            sx={
              !maskInverted ? selectedConnectedButtonSx : connectedButtonSx
            }
          >
            Normal
          </Button>
          <Button
            onClick={() => onSetMaskInverted(true)}
            sx={maskInverted ? selectedConnectedButtonSx : connectedButtonSx}
          >
            Inverted
          </Button>
        </ButtonGroup>
      </Box>
    </Box>
  );
});
