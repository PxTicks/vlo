import { useCallback, useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import {
  Box,
  Button,
  Divider,
  MenuItem,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useShallow } from "zustand/react/shallow";
import type {
  TextAlignment,
  TextClipData,
  TextTimelineClip,
  TimelineClip,
} from "../../types/TimelineTypes";
import {
  BufferedTextInput,
  CommittedTextInput,
  PanelSection,
} from "../panelUI";
import { useTimelineStore } from "../timeline";
import { TEXT_FONT_OPTIONS } from "./constants";
import { insertTextClipAtPlayhead } from "./utils/insertTextClipAtPlayhead";
import { resolveTextClipData } from "./utils/textClipData";

const PANEL_BG = "#121212";
const SECTION_BG = "#18181b";

interface TextFormFieldsProps {
  value: TextClipData;
  onChange: (updates: Partial<TextClipData>) => void;
  contentMode: "draft" | "selected";
}

interface BufferedColorFieldProps {
  value: string;
  onCommit: (value: string) => void;
}

function isTextClip(clip: TimelineClip | undefined): clip is TextTimelineClip {
  return clip?.type === "text";
}

function BufferedColorField({ value, onCommit }: BufferedColorFieldProps) {
  const [localValue, setLocalValue] = useState(value);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const commit = useCallback(() => {
    if (localValue !== value) {
      onCommit(localValue);
    }
  }, [localValue, onCommit, value]);

  return (
    <TextField
      label="Color"
      size="small"
      type="color"
      value={localValue}
      onChange={(event) => setLocalValue(event.target.value)}
      onBlur={commit}
      sx={{ minWidth: 96 }}
    />
  );
}

function TextFormFields({
  value,
  onChange,
  contentMode,
}: TextFormFieldsProps) {
  const handleAlignmentChange = useCallback(
    (_event: MouseEvent<HTMLElement>, nextAlignment: TextAlignment | null) => {
      if (!nextAlignment) {
        return;
      }

      onChange({ align: nextAlignment });
    },
    [onChange],
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      {contentMode === "draft" ? (
        <BufferedTextInput
          label="Content"
          value={value.content}
          onCommit={(content) => onChange({ content })}
          multiline={true}
          minRows={4}
          maxRows={10}
          placeholder="Write something"
        />
      ) : (
        <CommittedTextInput
          label="Content"
          initialValue={value.content}
          onCommit={(content) => onChange({ content })}
          multiline={true}
          minRows={4}
          maxRows={10}
          placeholder="Write something"
        />
      )}

      <TextField
        select={true}
        label="Font"
        size="small"
        value={value.fontFamily}
        onChange={(event) => onChange({ fontFamily: event.target.value })}
        fullWidth
      >
        {TEXT_FONT_OPTIONS.map((fontFamily) => (
          <MenuItem key={fontFamily} value={fontFamily}>
            {fontFamily}
          </MenuItem>
        ))}
      </TextField>

      <Box sx={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 1.5 }}>
        <TextField
          label="Size"
          size="small"
          type="number"
          value={value.fontSize}
          onChange={(event) => {
            const nextFontSize = Number(event.target.value);
            if (Number.isFinite(nextFontSize)) {
              onChange({ fontSize: nextFontSize });
            }
          }}
          inputProps={{ min: 8, max: 400, step: 1 }}
        />
        <BufferedColorField
          value={value.fill}
          onCommit={(fill) => onChange({ fill })}
        />
      </Box>

      <Box>
        <Typography
          variant="caption"
          sx={{ display: "block", mb: 0.75, color: "#a1a1aa" }}
        >
          Alignment
        </Typography>
        <ToggleButtonGroup
          exclusive={true}
          value={value.align}
          onChange={handleAlignmentChange}
          size="small"
          sx={{ width: "100%" }}
        >
          <ToggleButton value="left" aria-label="Align left" sx={{ flex: 1 }}>
            Left
          </ToggleButton>
          <ToggleButton value="center" aria-label="Align center" sx={{ flex: 1 }}>
            Center
          </ToggleButton>
          <ToggleButton value="right" aria-label="Align right" sx={{ flex: 1 }}>
            Right
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>
    </Box>
  );
}

export function TextPanel() {
  const { clips, selectedClipIds, updateTextClipData } = useTimelineStore(
    useShallow((state) => ({
      clips: state.clips,
      selectedClipIds: state.selectedClipIds,
      updateTextClipData: state.updateTextClipData,
    })),
  );
  const [draftTextData, setDraftTextData] = useState<TextClipData>(() =>
    resolveTextClipData(),
  );

  const selectedTextClip = useMemo(() => {
    if (selectedClipIds.length !== 1) {
      return null;
    }

    const selectedClip = clips.find((clip) => clip.id === selectedClipIds[0]);
    return isTextClip(selectedClip)
      ? {
          ...selectedClip,
          textData: resolveTextClipData(selectedClip.textData),
        }
      : null;
  }, [clips, selectedClipIds]);
  const hasClipSelection = selectedClipIds.length > 0;

  const handleDraftChange = useCallback((updates: Partial<TextClipData>) => {
    setDraftTextData((current) => resolveTextClipData({ ...current, ...updates }));
  }, []);

  const handleSelectedClipChange = useCallback(
    (updates: Partial<TextClipData>) => {
      if (!selectedTextClip) {
        return;
      }

      updateTextClipData(selectedTextClip.id, updates);
    },
    [selectedTextClip, updateTextClipData],
  );

  const handleAddTextClip = useCallback(() => {
    insertTextClipAtPlayhead(draftTextData);
  }, [draftTextData]);

  const canCreateTextClip = draftTextData.content.trim().length > 0;

  return (
    <Box
      data-testid="text-panel"
      sx={{
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        minWidth: 0,
        bgcolor: PANEL_BG,
        color: "#f4f4f5",
        overflowY: "auto",
        p: 1.5,
      }}
    >
      {selectedTextClip ? (
        <PanelSection
          title="Selected Text Clip"
          bgColor={SECTION_BG}
          defaultOpen={true}
        >
          <TextFormFields
            value={selectedTextClip.textData}
            onChange={handleSelectedClipChange}
            contentMode="selected"
          />
        </PanelSection>
      ) : hasClipSelection ? (
        <Box sx={{ px: 1, pt: 1 }}>
          <Typography variant="body2" sx={{ color: "#a1a1aa" }}>
            Select a text clip to edit it, or clear the current selection to
            create a new one.
          </Typography>
        </Box>
      ) : (
        <PanelSection title="New Text" bgColor={SECTION_BG} defaultOpen={true}>
          <TextFormFields
            value={draftTextData}
            onChange={handleDraftChange}
            contentMode="draft"
          />
          <Divider sx={{ borderColor: "#2b2b31", my: 1.5 }} />
          <Button
            variant="contained"
            onClick={handleAddTextClip}
            disabled={!canCreateTextClip}
            fullWidth
          >
            Add Text Clip
          </Button>
        </PanelSection>
      )}
    </Box>
  );
}
