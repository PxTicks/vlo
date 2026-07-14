import { useMemo, useState, useSyncExternalStore } from "react";
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
import { extensionParameterPresetRegistry } from "../../extensions/registry/publicApi";
import { COLOR_GRADE_FILTER_NAME } from "../../transformations/catalogue/filters/colorGrade";
import type { GradeParameterJson, GradeTimeRange } from "../gradeParameters";
import {
  captureGradeParameters,
  captureGradePresetParameters,
  copyGradeParameters,
  readCopiedGradeParameters,
  remapGradeParameterTimes,
} from "../gradeParameters";
import {
  BUILT_IN_GRADE_PRESETS,
  useGradePresetStore,
} from "../useGradePresetStore";

interface PresetEntry {
  readonly id: string;
  readonly name: string;
  readonly parameters: GradeParameterJson;
  readonly sourceTimeRange?: GradeTimeRange;
}

const EXTENSION_PRESET_TARGET = {
  kind: "filter",
  filterName: COLOR_GRADE_FILTER_NAME,
} as const;

function subscribeExtensionPresets(listener: () => void): () => void {
  return extensionParameterPresetRegistry.subscribe(listener);
}

function getExtensionPresetRevision(): number {
  return extensionParameterPresetRegistry.getRevision();
}

export function GradeManagementControl({
  values,
  onCommitMany,
  disabled,
  sourceTimeRange,
}: CustomControlRenderProps) {
  const [name, setName] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [message, setMessage] = useState("");
  const customPresets = useGradePresetStore((state) => state.presets);
  const savePreset = useGradePresetStore((state) => state.savePreset);
  const removePreset = useGradePresetStore((state) => state.removePreset);
  const extensionRevision = useSyncExternalStore(
    subscribeExtensionPresets,
    getExtensionPresetRevision,
    getExtensionPresetRevision,
  );
  // Extension presets are static, validated patches, so they merge into the same
  // dropdown and apply through the same commit path as the other two sources.
  // Deactivating an extension drops its entries without touching applied grades.
  const extensionPresets = useMemo<readonly PresetEntry[]>(
    () =>
      extensionParameterPresetRegistry
        .list(EXTENSION_PRESET_TARGET)
        .map((contribution) => ({
          id: contribution.id,
          name: contribution.definition.label,
          parameters: contribution.definition.parameters,
        })),
    // `extensionRevision` is the registry's change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extensionRevision],
  );
  const presets = useMemo<readonly PresetEntry[]>(
    () => [
      ...BUILT_IN_GRADE_PRESETS,
      ...customPresets.map((preset) => ({
        ...preset,
        // Legacy user presets may contain a project-local LUT asset ID. Never
        // apply that ID in another project; look packs materialize explicitly.
        parameters: captureGradePresetParameters(preset.parameters),
      })),
      ...extensionPresets,
    ],
    [customPresets, extensionPresets],
  );

  const applyPreset = (id: string): void => {
    setSelectedPresetId(id);
    const preset = presets.find((entry) => entry.id === id);
    if (!preset) return;
    onCommitMany(
      remapGradeParameterTimes(
        preset.parameters,
        preset.sourceTimeRange,
        sourceTimeRange,
      ),
    );
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
            const presetName = name.trim();
            const omitsProjectLut =
              typeof values.lutAssetId === "string" &&
              values.lutAssetId.length > 0;
            savePreset(
              name,
              captureGradePresetParameters(values),
              sourceTimeRange,
            );
            setMessage(
              omitsProjectLut
                ? `Saved ${presetName} without its project-local LUT. Use a look pack to share LUTs across projects.`
                : `Saved ${presetName}`,
            );
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
            copyGradeParameters(captureGradeParameters(values), sourceTimeRange);
            setMessage("Grade copied");
          }}
        >
          Copy grade
        </Button>
        <Button
          size="small"
          startIcon={<ContentPasteIcon />}
          disabled={disabled}
          onClick={async () => {
            const copied = await readCopiedGradeParameters(sourceTimeRange);
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
