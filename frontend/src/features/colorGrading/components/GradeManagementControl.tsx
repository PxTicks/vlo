import { useMemo, useState } from "react";
import {
  Box,
  Button,
  IconButton,
  MenuItem,
  Select,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ContentPasteIcon from "@mui/icons-material/ContentPaste";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import type { CustomControlRenderProps } from "../../panelUI";
import {
  captureGradeParameters,
  copyGradeParameters,
  readCopiedGradeParameters,
} from "../gradeParameters";
import {
  BUILT_IN_GRADE_PRESETS,
  useGradePresetStore,
} from "../useGradePresetStore";

export function GradeManagementControl({
  values,
  onCommitMany,
  disabled,
}: CustomControlRenderProps) {
  const [name, setName] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [message, setMessage] = useState("");
  const customPresets = useGradePresetStore((state) => state.presets);
  const savePreset = useGradePresetStore((state) => state.savePreset);
  const removePreset = useGradePresetStore((state) => state.removePreset);
  const presets = useMemo(
    () => [...BUILT_IN_GRADE_PRESETS, ...customPresets],
    [customPresets],
  );

  const applyPreset = (id: string): void => {
    setSelectedPresetId(id);
    const preset = presets.find((entry) => entry.id === id);
    if (!preset) return;
    onCommitMany(preset.parameters);
    setMessage(`Applied ${preset.name}`);
  };

  return (
    <Box sx={{ display: "grid", gap: 1 }}>
      <Box sx={{ display: "flex", gap: 0.75 }}>
        <Select
          size="small"
          displayEmpty
          value={selectedPresetId}
          disabled={disabled}
          aria-label="Grade preset"
          onChange={(event) => applyPreset(event.target.value)}
          sx={{ flex: 1, minWidth: 0 }}
        >
          <MenuItem value="" disabled>Apply preset…</MenuItem>
          {presets.map((preset) => (
            <MenuItem key={preset.id} value={preset.id}>{preset.name}</MenuItem>
          ))}
        </Select>
        <Tooltip title="Delete selected custom preset">
          <span>
            <IconButton
              size="small"
              aria-label="Delete grade preset"
              disabled={disabled || !customPresets.some((preset) => preset.id === selectedPresetId)}
              onClick={() => {
                removePreset(selectedPresetId);
                setSelectedPresetId("");
              }}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      <Box sx={{ display: "flex", gap: 0.75 }}>
        <TextField
          size="small"
          value={name}
          disabled={disabled}
          label="Preset name"
          onChange={(event) => setName(event.target.value)}
          sx={{ flex: 1 }}
        />
        <IconButton
          size="small"
          aria-label="Save grade preset"
          disabled={disabled || name.trim().length === 0}
          onClick={() => {
            savePreset(name, captureGradeParameters(values));
            setMessage(`Saved ${name.trim()}`);
            setName("");
          }}
        >
          <SaveOutlinedIcon fontSize="small" />
        </IconButton>
      </Box>
      <Box sx={{ display: "flex", gap: 1 }}>
        <Button
          size="small"
          startIcon={<ContentCopyIcon />}
          disabled={disabled}
          onClick={() => {
            copyGradeParameters(captureGradeParameters(values));
            setMessage("Grade copied");
          }}
        >
          Copy grade
        </Button>
        <Button
          size="small"
          startIcon={<ContentPasteIcon />}
          disabled={disabled}
          onClick={() => {
            const copied = readCopiedGradeParameters();
            if (!copied) {
              setMessage("No copied grade");
              return;
            }
            onCommitMany(copied);
            setMessage("Grade pasted");
          }}
        >
          Paste grade
        </Button>
      </Box>
      {message ? (
        <Typography role="status" variant="caption" color="text.secondary">
          {message}
        </Typography>
      ) : null}
    </Box>
  );
}
