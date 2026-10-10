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
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { PROJECT_ASPECT_RATIOS } from "../../project";
import { MaskCropPaddingControl } from "../components/MaskCropPaddingControl";
import type { DerivedMaskSourceVideoTreatment } from "../pipeline/types";
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
          <Typography variant="subtitle2">Source video</Typography>
          <FormControl size="small">
            <InputLabel id="iframe-selection-source-treatment-label">
              Masks
            </InputLabel>
            <Select
              labelId="iframe-selection-source-treatment-label"
              label="Masks"
              value={settings.sourceVideoTreatment}
              onChange={(event) =>
                onChange({
                  ...settings,
                  sourceVideoTreatment: event.target
                    .value as DerivedMaskSourceVideoTreatment,
                })
              }
              data-testid="iframe-selection-source-treatment"
            >
              <MenuItem value="remove_transparency">
                Render unmasked (matches the Generate panel)
              </MenuItem>
              <MenuItem value="preserve_transparency">
                Apply masks (transparent areas turn black)
              </MenuItem>
            </Select>
          </FormControl>
          <Typography variant="body2" color="text.secondary">
            Either way, masks are also rendered as a separate matte.
          </Typography>
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
          <MaskCropPaddingControl
            label="Crop padding"
            value={settings.maskCrop.dilation}
            disabled={settings.maskCrop.mode === "full"}
            onChange={(dilation) => updateMaskCrop({ dilation })}
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}
