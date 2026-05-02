import { memo } from "react";
import {
  Box,
  Button,
  ButtonGroup,
  Divider,
  Slider,
  Typography,
} from "@mui/material";
import { Brush, Crop75, Edit } from "@mui/icons-material";
import type { ClipMaskMode } from "../../../types/TimelineTypes";
import {
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  type BrushTool,
} from "../store/useMaskViewStore";

const connectedButtonSx = {
  textTransform: "none",
  borderColor: "#2f333a",
  bgcolor: "#4a4f57",
  color: "#f2f3f5",
  "&:hover": {
    bgcolor: "#5a606b",
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

interface BrushMaskPanelProps {
  maskMode: ClipMaskMode;
  maskInverted: boolean;
  maskLabel: string;
  brushTool: BrushTool;
  brushRadius: number;
  hasBrushAsset: boolean;
  onSetBrushTool: (tool: BrushTool) => void;
  onSetBrushRadius: (radius: number) => void;
  onClearBrush: () => void | Promise<void>;
  onSetMaskMode: (mode: ClipMaskMode) => void;
  onSetMaskInverted: (inverted: boolean) => void;
}

export const BrushMaskPanel = memo(function BrushMaskPanel({
  maskMode,
  maskInverted,
  maskLabel,
  brushTool,
  brushRadius,
  hasBrushAsset,
  onSetBrushTool,
  onSetBrushRadius,
  onClearBrush,
  onSetMaskMode,
  onSetMaskInverted,
}: BrushMaskPanelProps) {
  return (
    <Box
      data-testid="brush-mask-panel"
      sx={{ display: "flex", flexDirection: "column", gap: 1 }}
    >
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
          — Type: Brush
        </Typography>
      </Box>

      <Box sx={{ px: 2 }}>
        <Divider sx={{ borderColor: "#2a2d33", mb: 1.5 }} />
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            display: "block",
            mb: 1,
            fontWeight: 600,
          }}
        >
          Tool
        </Typography>
        <ButtonGroup
          variant="contained"
          disableElevation
          size="small"
          fullWidth
          sx={{ mb: 1 }}
        >
          <Button
            data-testid="brush-tool-paint"
            onClick={() => onSetBrushTool("paint")}
            startIcon={<Brush fontSize="small" />}
            sx={
              brushTool === "paint"
                ? selectedConnectedButtonSx
                : connectedButtonSx
            }
          >
            Paint
          </Button>
          <Button
            data-testid="brush-tool-erase"
            onClick={() => onSetBrushTool("erase")}
            startIcon={<Edit fontSize="small" />}
            sx={
              brushTool === "erase"
                ? selectedConnectedButtonSx
                : connectedButtonSx
            }
          >
            Erase
          </Button>
          <Button
            data-testid="brush-tool-gizmo"
            onClick={() => onSetBrushTool("gizmo")}
            startIcon={<Crop75 fontSize="small" />}
            sx={
              brushTool === "gizmo"
                ? selectedConnectedButtonSx
                : connectedButtonSx
            }
          >
            Gizmo
          </Button>
        </ButtonGroup>

        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
            mb: 0.5,
          }}
        >
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block" }}
          >
            Brush size
          </Typography>
          <Typography
            variant="caption"
            sx={{ color: "text.disabled", display: "block" }}
          >
            {brushRadius}px
          </Typography>
        </Box>
        <Slider
          data-testid="brush-radius-slider"
          aria-label="Brush radius"
          size="small"
          value={brushRadius}
          min={MIN_BRUSH_RADIUS}
          max={MAX_BRUSH_RADIUS}
          step={1}
          onChange={(_event, value) => {
            onSetBrushRadius(Array.isArray(value) ? value[0] : value);
          }}
          sx={{
            color: "#60a5fa",
            "& .MuiSlider-thumb": { width: 14, height: 14 },
          }}
        />

        <Button
          variant="text"
          size="small"
          onClick={() => {
            void onClearBrush();
          }}
          disabled={!hasBrushAsset}
          sx={{
            textTransform: "none",
            color: "text.secondary",
            p: 0,
            minWidth: 0,
            mt: 0.5,
            "&:hover": { color: "#ef4444" },
          }}
        >
          Clear Brush
        </Button>
      </Box>

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
