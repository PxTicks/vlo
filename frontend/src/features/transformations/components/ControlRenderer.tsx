import { useState, useEffect, useRef, memo, useMemo } from "react";
import {
  Box,
  IconButton,
} from "@mui/material";
import type { ControlDefinition } from "../../panelUI/types";
import { SelectControl } from "../../panelUI/components/SelectControl";
import { LinkControl } from "../../panelUI/components/LinkControl";
import { NumberControl as PanelNumberControl } from "../../panelUI/components/NumberControl";
import { SpacerControl } from "../../panelUI/components/SpacerControl";
import { SliderControl as PanelSliderControl } from "../../panelUI/components/SliderControl";
import { Timeline } from "@mui/icons-material";
import { SplineEditorPopover } from "./SplineEditorPopover";
import { useSplinePopover } from "../hooks/useSplinePopover";
import { liveParamStore } from "../services/liveParamStore";
import { livePreviewParamStore } from "../services/livePreviewParamStore";

// --- Shared props for controls that support splines ---
interface NumericControlProps {
  control: ControlDefinition;
  value: unknown;
  onCommit: (val: unknown) => void;
  minTime: number;
  duration: number;
  groupId: string;
  context?: { clipId: string; transformId: string; property: string };
  transformId?: string;
}

// --- Spline toggle button (shared between ScalarControl and SliderControl) ---
function SplineToggleButton({
  supportsSpline,
  isSpline,
  onOpen,
  compact,
}: {
  supportsSpline?: boolean;
  isSpline: boolean;
  onOpen: (event: React.MouseEvent<HTMLButtonElement>) => void;
  compact?: boolean;
}) {
  if (!supportsSpline) return null;
  return (
    <IconButton
      size="small"
      onClick={onOpen}
      color={isSpline ? "primary" : "default"}
      title="Edit Animation Curve"
      {...(compact
        ? { sx: { padding: 0.5 } }
        : { edge: "end" as const })}
    >
      <Timeline fontSize="small" {...(compact ? { sx: { fontSize: "1rem" } } : {})} />
    </IconButton>
  );
}

// --- Scalar Control (Number input + optional Spline) ---
function ScalarControl({
  control,
  value,
  onCommit,
  minTime,
  duration,
  context,
  transformId,
}: NumericControlProps) {
  const {
    isSpline,
    numericValue,
    anchorEl,
    open,
    handleOpenGraph,
    handleAccept,
    handleCancel,
    handleClear,
  } = useSplinePopover({ value, onCommit, minTime, duration, defaultValue: control.defaultValue, context });

  // Ref forwarded to the underlying <input> element of BufferedInput.
  // Updated imperatively by liveParamStore during playback — no React re-render.
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!transformId) return;
    return liveParamStore.subscribe(transformId, control.name, (modelVal) => {
      const displayVal = control.valueTransform?.toView
        ? (control.valueTransform.toView(modelVal) as number)
        : modelVal;
      if (inputRef.current && document.activeElement !== inputRef.current) {
        inputRef.current.value = String(+displayVal.toFixed(4));
      }
    });
  }, [transformId, control.name, control.valueTransform]);

  return (
    <Box>
      <PanelNumberControl
        inputRef={inputRef}
        label={control.label}
        value={numericValue}
        step={control.step}
        onCommit={onCommit}
        endAdornment={
          <SplineToggleButton
            supportsSpline={control.supportsSpline}
            isSpline={isSpline}
            onOpen={handleOpenGraph}
          />
        }
      />
      <SplineEditorPopover
        open={open}
        anchorEl={anchorEl}
        onAccept={handleAccept}
        onCancel={handleCancel}
        onClear={handleClear}
        isSpline={isSpline}
        value={value}
        onCommit={onCommit}
        control={control}
        minTime={minTime}
        duration={duration}
      />
    </Box>
  );
}

// --- Slider Control ---
function TransformSliderControl({
  control,
  value,
  onCommit,
  minTime,
  duration,
  groupId,
  context,
  transformId,
}: NumericControlProps) {
  const {
    isSpline,
    numericValue,
    anchorEl,
    open,
    handleOpenGraph,
    handleAccept,
    handleCancel,
    handleClear,
  } = useSplinePopover({ value, onCommit, minTime, duration, defaultValue: control.defaultValue, context });

  const min = control.min ?? 0;
  const max = control.max ?? 100;
  const step = control.step ?? 1;
  const [localValue, setLocalValue] = useState(numericValue);
  const canPreviewWithoutCommit = Boolean(transformId) && groupId !== "speed";

  // Sync with prop updates (e.g. user seeks while paused, or edits a keyframe value).
  // This does NOT fire during playback because `numericValue` only changes when the
  // spline definition object itself changes, not when the playhead moves.
  useEffect(() => {
    setLocalValue(numericValue);
  }, [numericValue]);

  useEffect(() => {
    if (!transformId) return;
    return () => {
      livePreviewParamStore.clear(transformId, control.name);
    };
  }, [control.name, transformId]);

  // Ref for the number input — updated imperatively by liveParamStore during playback.
  const textInputRef = useRef<HTMLInputElement>(null);
  // Ref for the MUI Slider root element — used for imperative thumb/track updates.
  const sliderRef = useRef<HTMLSpanElement>(null);
  // Guard: don't override DOM while the user is dragging the slider handle.
  const isDraggingRef = useRef(false);

  useEffect(() => {
    if (!transformId) return;

    return liveParamStore.subscribe(transformId, control.name, (modelVal) => {
      const displayVal = control.valueTransform?.toView
        ? (control.valueTransform.toView(modelVal) as number)
        : modelVal;

      // --- text input ---
      if (
        textInputRef.current &&
        document.activeElement !== textInputRef.current
      ) {
        textInputRef.current.value = String(+displayVal.toFixed(4));
      }

      // --- slider thumb + track ---
      // MUI Slider positions the thumb with `style.left = '${pct}%'` (horizontal)
      // and the filled track with `style.width = '${pct}%'`.
      if (!isDraggingRef.current && sliderRef.current) {
        const clamped = Math.min(Math.max(displayVal, min), max);
        const pct = ((clamped - min) / (max - min)) * 100;
        const thumb = sliderRef.current.querySelector(
          ".MuiSlider-thumb",
        ) as HTMLElement | null;
        const track = sliderRef.current.querySelector(
          ".MuiSlider-track",
        ) as HTMLElement | null;
        if (thumb) thumb.style.left = `${pct}%`;
        if (track) track.style.width = `${pct}%`;
      }
    });
  }, [
    transformId,
    control.name,
    control.min,
    control.max,
    control.valueTransform,
    min,
    max,
  ]);

  const handleChange = (_: Event, newValue: number | number[]) => {
    const nextValue = newValue as number;
    setLocalValue(nextValue);

    if (!transformId || !canPreviewWithoutCommit) {
      onCommit(nextValue);
      return;
    }

    const modelValue = control.valueTransform?.toModel
      ? (control.valueTransform.toModel(nextValue) as number)
      : nextValue;
    livePreviewParamStore.set(transformId, control.name, modelValue);
  };

  const handleSliderCommit = (
    _: Event | React.SyntheticEvent | unknown,
    newValue: number | number[],
  ) => {
    const nextValue = newValue as number;
    onCommit(nextValue);
    if (transformId && canPreviewWithoutCommit) {
      livePreviewParamStore.clear(transformId, control.name);
    }
  };

  const handleInputChange = (val: number) => {
    const clamped = Math.min(Math.max(val, min), max);

    setLocalValue(clamped);
    onCommit(clamped);
    if (transformId && canPreviewWithoutCommit) {
      livePreviewParamStore.clear(transformId, control.name);
    }
  };

  return (
    <Box>
      <PanelSliderControl
        label={control.label}
        value={localValue}
        min={min}
        max={max}
        step={step}
        onChange={handleChange}
        onChangeCommitted={handleSliderCommit}
        onInputCommit={handleInputChange}
        inputRef={textInputRef}
        sliderRef={sliderRef}
        endAdornment={
          <SplineToggleButton
            supportsSpline={control.supportsSpline}
            isSpline={isSpline}
            onOpen={handleOpenGraph}
            compact
          />
        }
        onMouseDown={() => {
          isDraggingRef.current = true;
        }}
        onMouseUp={() => {
          isDraggingRef.current = false;
        }}
      />
      <SplineEditorPopover
        open={open}
        anchorEl={anchorEl}
        onAccept={handleAccept}
        onCancel={handleCancel}
        onClear={handleClear}
        isSpline={isSpline}
        value={value}
        onCommit={onCommit}
        control={control}
        minTime={minTime}
        duration={duration}
      />
    </Box>
  );
}

// --- Control Renderer ---
interface ControlRendererProps {
  control: ControlDefinition;
  value: unknown;

  // Pre-wrapped commit handler: (value) => void
  // The ControlGroup render prop already wraps with groupId and controlName
  onCommit: (value: unknown) => void;

  // Identifiers for this specific control instance
  groupId: string;
  transformId?: string;
  clipId?: string; // Needed for Spline Overlay sync

  minTime?: number;
  duration?: number;
}

export const ControlRenderer = memo(function ControlRenderer({
  control,
  value,
  onCommit,
  groupId,
  transformId,
  clipId,
  minTime = 0,
  duration = 10,
}: ControlRendererProps) {
  const context = useMemo(
    () =>
      transformId && clipId
        ? { clipId, transformId, property: control.name }
        : undefined,
    [transformId, clipId, control.name],
  );

  if (control.type === "number") {
    return (
      <ScalarControl
        control={control}
        value={value}
        onCommit={onCommit}
        minTime={minTime}
        duration={duration}
        context={context}
        transformId={transformId}
        groupId={groupId}
      />
    );
  }

  if (control.type === "slider") {
    return (
      <TransformSliderControl
        control={control}
        value={value}
        onCommit={onCommit}
        minTime={minTime}
        duration={duration}
        context={context}
        transformId={transformId}
        groupId={groupId}
      />
    );
  }

  if (control.type === "link") {
    return <LinkControl value={value} onCommit={onCommit} />;
  }

  if (control.type === "spacer") {
    return <SpacerControl />;
  }

  if (control.type === "select") {
    return (
      <SelectControl control={control} value={value} onCommit={onCommit} />
    );
  }

  return null;
});
