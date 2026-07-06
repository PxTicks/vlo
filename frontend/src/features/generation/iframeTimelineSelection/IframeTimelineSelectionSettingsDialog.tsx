import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Slider,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { PROJECT_ASPECT_RATIOS } from "../../project";
import type { IframeTimelineSelectionSettings } from "./types";

interface IframeTimelineSelectionSettingsDialogProps {
  open: boolean;
  settings: IframeTimelineSelectionSettings;
  onChange: (settings: IframeTimelineSelectionSettings) => void;
  onClose: () => void;
}

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function IframeTimelineSelectionSettingsDialog({
  open,
  settings,
  onChange,
  onClose,
}: IframeTimelineSelectionSettingsDialogProps) {
  const updateAspectRatio = (
    updates: Partial<IframeTimelineSelectionSettings["aspectRatio"]>,
  ) => {
    onChange({
      ...settings,
      aspectRatio: { ...settings.aspectRatio, ...updates },
    });
  };
  const updateMaskCrop = (
    updates: Partial<IframeTimelineSelectionSettings["maskCrop"]>,
  ) => {
    onChange({
      ...settings,
      maskCrop: { ...settings.maskCrop, ...updates },
    });
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Timeline selection settings</DialogTitle>
      <DialogContent
        dividers
        sx={{ display: "flex", flexDirection: "column", gap: 2.5 }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          <FormControlLabel
            control={
              <Switch
                checked={settings.aspectRatio.enabled}
                onChange={(event) =>
                  updateAspectRatio({ enabled: event.target.checked })
                }
              />
            }
            label="Apply aspect-ratio processing"
          />
          <Typography variant="body2" color="text.secondary">
            Renders the selection at model-friendly strided dimensions. The
            video and any mask use the same stretch.
          </Typography>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 1.5,
            }}
          >
            <FormControl
              size="small"
              disabled={!settings.aspectRatio.enabled}
            >
              <InputLabel id="iframe-selection-aspect-ratio-label">
                Aspect ratio
              </InputLabel>
              <Select
                labelId="iframe-selection-aspect-ratio-label"
                label="Aspect ratio"
                value={settings.aspectRatio.targetAspectRatio}
                onChange={(event) =>
                  updateAspectRatio({ targetAspectRatio: event.target.value })
                }
              >
                {PROJECT_ASPECT_RATIOS.map((aspectRatio) => (
                  <MenuItem key={aspectRatio} value={aspectRatio}>
                    {aspectRatio}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              size="small"
              label="Short-edge resolution"
              type="number"
              disabled={!settings.aspectRatio.enabled}
              value={settings.aspectRatio.targetResolution}
              onChange={(event) =>
                updateAspectRatio({
                  targetResolution: positiveInteger(
                    event.target.value,
                    settings.aspectRatio.targetResolution,
                  ),
                })
              }
              inputProps={{ min: 1 }}
            />
            <TextField
              size="small"
              label="Stride"
              type="number"
              disabled={!settings.aspectRatio.enabled}
              value={settings.aspectRatio.stride}
              onChange={(event) =>
                updateAspectRatio({
                  stride: positiveInteger(
                    event.target.value,
                    settings.aspectRatio.stride,
                  ),
                })
              }
              inputProps={{ min: 1 }}
            />
            <TextField
              size="small"
              label="Search steps"
              type="number"
              disabled={!settings.aspectRatio.enabled}
              value={settings.aspectRatio.searchSteps}
              onChange={(event) =>
                updateAspectRatio({
                  searchSteps: Math.max(
                    0,
                    Number.parseInt(event.target.value, 10) || 0,
                  ),
                })
              }
              inputProps={{ min: 0 }}
            />
          </Box>
        </Box>

        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Typography variant="subtitle2">Mask crop</Typography>
          <FormControl size="small">
            <InputLabel id="iframe-selection-mask-mode-label">Mode</InputLabel>
            <Select
              labelId="iframe-selection-mask-mode-label"
              label="Mode"
              value={settings.maskCrop.mode}
              onChange={(event) =>
                updateMaskCrop({
                  mode: event.target.value as "crop" | "full",
                })
              }
            >
              <MenuItem value="full">Full frame</MenuItem>
              <MenuItem value="crop">Crop to transparency</MenuItem>
            </Select>
          </FormControl>
          <Box sx={{ px: 1 }}>
            <Typography variant="caption" color="text.secondary">
              Crop padding: {Math.round(settings.maskCrop.dilation * 100)}%
            </Typography>
            <Slider
              value={settings.maskCrop.dilation}
              min={0}
              max={0.5}
              step={0.01}
              disabled={settings.maskCrop.mode === "full"}
              onChange={(_, value) =>
                updateMaskCrop({ dilation: value as number })
              }
              valueLabelDisplay="auto"
              valueLabelFormat={(value) => `${Math.round(value * 100)}%`}
            />
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}
