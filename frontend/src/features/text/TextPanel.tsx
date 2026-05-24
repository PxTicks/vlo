import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  TextRun,
} from "../../types/TimelineTypes";
import { isTextClip } from "../../types/TimelineTypes";
import {
  BufferedColorInput,
  BufferedInput,
  PanelSection,
  RichTextInput,
} from "../panelUI";
import { useTimelineStore } from "../timeline";
import { TEXT_FONT_OPTIONS } from "./constants";
import { livePreviewTextStore } from "./services/livePreviewTextStore";
import { insertTextClipAtPlayhead } from "./utils/insertTextClipAtPlayhead";
import {
  hasRichFormatting,
  plainTextToRuns,
  resolveTextClipData,
  runsToPlainText,
} from "./utils/textClipData";

const PANEL_BG = "#121212";
const SECTION_BG = "#18181b";

function textDataToInitialRuns(value: TextClipData): TextRun[] {
  if (value.runs !== undefined && value.runs.length > 0) {
    return value.runs;
  }
  return plainTextToRuns(value.content);
}

function buildContentUpdate(runs: TextRun[]): Partial<TextClipData> {
  const content = runsToPlainText(runs);
  return hasRichFormatting(runs)
    ? { content, runs }
    : { content, runs: undefined };
}

interface TextFormFieldsProps {
  value: TextClipData;
  editorKey: string;
  onChange: (updates: Partial<TextClipData>) => void;
  onContentPreview?: (runs: TextRun[]) => void;
  onContentEditEnd?: () => void;
  onColorPreview?: (fill: string) => void;
  onColorEditEnd?: () => void;
  onStrokeColorPreview?: (strokeColor: string) => void;
  onStrokeColorEditEnd?: () => void;
}

function hasPendingPreviewUpdates(value: Partial<TextClipData>): boolean {
  return Object.keys(value).length > 0;
}

function TextFormFields({
  value,
  editorKey,
  onChange,
  onContentPreview,
  onContentEditEnd,
  onColorPreview,
  onColorEditEnd,
  onStrokeColorPreview,
  onStrokeColorEditEnd,
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

  // Keyed on editorKey, not value: RichTextInput is remounted via key={editorKey}
  // and only reads initialValue at mount, so deliberately snapshot value then.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialRuns = useMemo(() => textDataToInitialRuns(value), [editorKey]);

  const handleContentCommit = useCallback(
    (runs: TextRun[]) => {
      onChange(buildContentUpdate(runs));
    },
    [onChange],
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      <RichTextInput
        key={editorKey}
        label="Content"
        initialValue={initialRuns}
        onCommit={handleContentCommit}
        onPreview={onContentPreview}
        onEditEnd={onContentEditEnd}
        minRows={4}
        placeholder="Write something"
      />

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
        <BufferedInput
          label="Size"
          value={value.fontSize}
          onCommit={(fontSize) => onChange({ fontSize })}
          step={1}
        />
        <BufferedColorInput
          value={value.fill}
          onCommit={(fill) => onChange({ fill })}
          onPreview={onColorPreview}
          onEditEnd={onColorEditEnd}
          sx={{ minWidth: 96 }}
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

      <Box>
        <Typography
          variant="caption"
          sx={{ display: "block", mb: 0.75, color: "#a1a1aa" }}
        >
          Stroke
        </Typography>
        <Box sx={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 1.5 }}>
          <BufferedInput
            label="Width"
            value={value.strokeWidth}
            onCommit={(strokeWidth) => onChange({ strokeWidth })}
            step={1}
          />
          <BufferedColorInput
            label="Stroke"
            value={value.strokeColor}
            onCommit={(strokeColor) => onChange({ strokeColor })}
            onPreview={onStrokeColorPreview}
            onEditEnd={onStrokeColorEditEnd}
            disabled={value.strokeWidth <= 0}
            sx={{ minWidth: 96 }}
          />
        </Box>
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
  const previewFrameIdRef = useRef<number | null>(null);
  const pendingPreviewUpdatesRef = useRef<Partial<TextClipData>>({});

  const selectedTextClip = (() => {
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
  })();
  const hasClipSelection = selectedClipIds.length > 0;
  const selectedTextClipId = selectedTextClip?.id ?? null;

  useEffect(() => {
    return () => {
      if (previewFrameIdRef.current !== null) {
        cancelAnimationFrame(previewFrameIdRef.current);
        previewFrameIdRef.current = null;
      }
      pendingPreviewUpdatesRef.current = {};
      if (selectedTextClipId) {
        livePreviewTextStore.clear(selectedTextClipId);
      }
    };
  }, [selectedTextClipId]);

  const handleDraftChange = useCallback((updates: Partial<TextClipData>) => {
    setDraftTextData((current) =>
      resolveTextClipData({ ...current, ...updates }),
    );
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

  const clearSelectedTextPreview = useCallback(
    (fields?: (keyof TextClipData)[]) => {
      if (!selectedTextClipId) {
        return;
      }

      if (!fields || fields.length === 0) {
        pendingPreviewUpdatesRef.current = {};
        if (previewFrameIdRef.current !== null) {
          cancelAnimationFrame(previewFrameIdRef.current);
          previewFrameIdRef.current = null;
        }
        livePreviewTextStore.clear(selectedTextClipId);
        return;
      }

      if (hasPendingPreviewUpdates(pendingPreviewUpdatesRef.current)) {
        const nextPendingUpdates = { ...pendingPreviewUpdatesRef.current };
        fields.forEach((field) => {
          delete nextPendingUpdates[field];
        });
        pendingPreviewUpdatesRef.current = nextPendingUpdates;

        if (
          !hasPendingPreviewUpdates(nextPendingUpdates) &&
          previewFrameIdRef.current !== null
        ) {
          cancelAnimationFrame(previewFrameIdRef.current);
          previewFrameIdRef.current = null;
        }
      }

      livePreviewTextStore.clear(selectedTextClipId, fields);
    },
    [selectedTextClipId],
  );

  const scheduleSelectedTextPreview = useCallback(
    (updates: Partial<TextClipData>) => {
      if (!selectedTextClipId) {
        return;
      }

      pendingPreviewUpdatesRef.current = {
        ...pendingPreviewUpdatesRef.current,
        ...updates,
      };
      if (previewFrameIdRef.current !== null) {
        return;
      }

      previewFrameIdRef.current = requestAnimationFrame(() => {
        previewFrameIdRef.current = null;
        const nextPreviewUpdates = pendingPreviewUpdatesRef.current;
        pendingPreviewUpdatesRef.current = {};
        if (!hasPendingPreviewUpdates(nextPreviewUpdates)) {
          return;
        }

        livePreviewTextStore.set(selectedTextClipId, nextPreviewUpdates);
      });
    },
    [selectedTextClipId],
  );

  const handleSelectedContentPreview = useCallback(
    (runs: TextRun[]) => {
      scheduleSelectedTextPreview(buildContentUpdate(runs));
    },
    [scheduleSelectedTextPreview],
  );

  const handleSelectedColorPreview = useCallback(
    (fill: string) => {
      scheduleSelectedTextPreview({ fill });
    },
    [scheduleSelectedTextPreview],
  );

  const handleSelectedStrokeColorPreview = useCallback(
    (strokeColor: string) => {
      scheduleSelectedTextPreview({ strokeColor });
    },
    [scheduleSelectedTextPreview],
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
            editorKey={selectedTextClip.id}
            onChange={handleSelectedClipChange}
            onContentPreview={handleSelectedContentPreview}
            onContentEditEnd={() =>
              clearSelectedTextPreview(["content", "runs"])
            }
            onColorPreview={handleSelectedColorPreview}
            onColorEditEnd={() => clearSelectedTextPreview(["fill"])}
            onStrokeColorPreview={handleSelectedStrokeColorPreview}
            onStrokeColorEditEnd={() => clearSelectedTextPreview(["strokeColor"])}
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
            editorKey="draft"
            onChange={handleDraftChange}
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
