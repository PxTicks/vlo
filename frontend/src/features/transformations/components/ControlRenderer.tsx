import { createElement, useState, useEffect, useRef, memo, useMemo } from "react";
import type { ReactElement } from "react";
import {
  Box,
  Checkbox,
  FormControlLabel,
  IconButton,
} from "@mui/material";
import type {
  ControlCommitOptions,
  ControlDefinition,
} from "../../panelUI/types";
import { getCustomControl } from "../../panelUI/customControlRegistry";
import { SelectControl } from "../../panelUI/components/SelectControl";
import { LinkControl } from "../../panelUI/components/LinkControl";
import { NumberControl as PanelNumberControl } from "../../panelUI/components/NumberControl";
import { SpacerControl } from "../../panelUI/components/SpacerControl";
import { SliderControl as PanelSliderControl } from "../../panelUI/components/SliderControl";
import { BufferedTextInput } from "../../panelUI/components/BufferedTextInput";
import { BufferedColorInput } from "../../panelUI/components/BufferedColorInput";
import { Timeline } from "@mui/icons-material";
import { SplineEditorPopover } from "./SplineEditorPopover";
import { useSplinePopover } from "../hooks/useSplinePopover";
import { useLiveParamSync } from "../hooks/useLiveParamSync";
import { livePreviewParamStore } from "../../../core/liveParams/livePreviewParamStore";
import type { GraphTimeAxis } from "../utils/clipTimeDomains";

// --- Shared props for controls that support splines ---
interface NumericControlProps {
  control: ControlDefinition;
  value: unknown;
  onCommit: (val: unknown, options?: ControlCommitOptions) => void;
  minTime: number;
  duration: number;
  timeAxis?: GraphTimeAxis;
  groupId: string;
  context?: { contextId: string; transformId?: string; property: string };
  transformId?: string;
  disabled?: boolean;
  captureSnapshot?: () => unknown | null;
  restoreSnapshot?: (snapshot: unknown) => void;
}

// --- Spline toggle button (shared between ScalarControl and SliderControl) ---
function SplineToggleButton({
  supportsSpline,
  isSpline,
  onOpen,
  compact,
  disabled,
}: {
  supportsSpline?: boolean;
  isSpline: boolean;
  onOpen: (event: React.MouseEvent<HTMLButtonElement>) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  if (!supportsSpline) return null;
  return (
    <IconButton
      size="small"
      onClick={onOpen}
      color={isSpline ? "primary" : "default"}
      title="Edit Animation Curve"
      disabled={disabled}
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
  timeAxis,
  context,
  transformId,
  disabled,
  captureSnapshot,
  restoreSnapshot,
}: NumericControlProps) {
  const {
    isSpline,
    numericValue,
    anchorEl,
    open,
    editorValue,
    commitSessionValue,
    handleOpenGraph,
    handleAccept,
    handleCancel,
    handleClear,
  } = useSplinePopover({
    value,
    onCommit,
    minTime,
    duration,
    defaultValue: control.defaultValue,
    context,
    captureSnapshot,
    restoreSnapshot,
  });

  // Ref forwarded to the underlying <input> element of BufferedInput.
  // Updated imperatively by liveParamStore during playback — no React re-render.
  const inputRef = useRef<HTMLInputElement>(null);

  useLiveParamSync(transformId, control.name, numericValue, (modelVal) => {
    const displayVal = control.valueTransform?.toView
      ? (control.valueTransform.toView(modelVal) as number)
      : modelVal;
    if (inputRef.current && document.activeElement !== inputRef.current) {
      inputRef.current.value = String(+displayVal.toFixed(4));
    }
  });

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
            disabled={disabled}
          />
        }
        disabled={disabled}
      />
      <SplineEditorPopover
        open={open}
        anchorEl={anchorEl}
        onAccept={handleAccept}
        onCancel={handleCancel}
        onClear={handleClear}
        isSpline={isSpline}
        value={editorValue}
        onCommit={commitSessionValue}
        control={control}
        minTime={minTime}
        duration={duration}
        timeAxis={timeAxis}
      />
    </Box>
  );
}

// --- Slider Control ---
let sliderGestureSequence = 0;

function TransformSliderControl({
  control,
  value,
  onCommit,
  minTime,
  duration,
  timeAxis,
  groupId,
  context,
  transformId,
  disabled,
  captureSnapshot,
  restoreSnapshot,
}: NumericControlProps) {
  const {
    isSpline,
    numericValue,
    anchorEl,
    open,
    editorValue,
    commitSessionValue,
    handleOpenGraph,
    handleAccept,
    handleCancel,
    handleClear,
  } = useSplinePopover({
    value,
    onCommit,
    minTime,
    duration,
    defaultValue: control.defaultValue,
    context,
    captureSnapshot,
    restoreSnapshot,
  });

  const min = control.min ?? 0;
  const max = control.max ?? 100;
  const step = control.step ?? 1;
  // Sync with prop updates (e.g. user seeks while paused, or edits a keyframe value)
  // using the "store previous render value" pattern so the buffered local value
  // tracks numericValue without an effect. This does NOT fire during playback
  // because `numericValue` only changes when the spline definition object itself
  // changes, not when the playhead moves.
  const [localValue, setLocalValue] = useState(numericValue);
  const [lastSyncedValue, setLastSyncedValue] = useState(numericValue);
  if (lastSyncedValue !== numericValue) {
    setLastSyncedValue(numericValue);
    setLocalValue(numericValue);
  }
  const canPreviewWithoutCommit = Boolean(transformId) && groupId !== "speed";

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
  // Every commit within one gesture shares a history key so the gesture is one
  // undo step. A drag commits per tick until a transformId exists to preview
  // against (first edit of a default group, or speed), then once on release.
  const gestureKeyRef = useRef<string | null>(null);
  const gestureCommitOptions = (end: boolean): ControlCommitOptions => {
    gestureKeyRef.current ??= `slider:${control.name}:${++sliderGestureSequence}`;
    const options = { historyCoalesce: { key: gestureKeyRef.current, end } };
    if (end) gestureKeyRef.current = null;
    return options;
  };

  useLiveParamSync(transformId, control.name, localValue, (modelVal) => {
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

  const handleChange = (_: Event, newValue: number | number[]) => {
    const nextValue = newValue as number;
    setLocalValue(nextValue);

    if (!transformId || !canPreviewWithoutCommit) {
      onCommit(nextValue, gestureCommitOptions(false));
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
    onCommit(nextValue, gestureCommitOptions(true));
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
            disabled={disabled}
          />
        }
        onMouseDown={() => {
          isDraggingRef.current = true;
        }}
        onMouseUp={() => {
          isDraggingRef.current = false;
        }}
        disabled={disabled}
      />
      <SplineEditorPopover
        open={open}
        anchorEl={anchorEl}
        onAccept={handleAccept}
        onCancel={handleCancel}
        onClear={handleClear}
        isSpline={isSpline}
        value={editorValue}
        onCommit={commitSessionValue}
        control={control}
        minTime={minTime}
        duration={duration}
        timeAxis={timeAxis}
      />
    </Box>
  );
}

// --- Control Renderer ---
interface ControlRendererProps {
  control: ControlDefinition;
  value: unknown;
  values?: Readonly<Record<string, unknown>>;

  // Pre-wrapped commit handler: (value) => void
  // The ControlGroup render prop already wraps with groupId and controlName
  onCommit: (value: unknown, options?: ControlCommitOptions) => void;
  onCommitMany?: (
    values: Readonly<Record<string, unknown>>,
    options?: ControlCommitOptions,
  ) => void;

  // Identifiers for this specific control instance
  groupId: string;
  transformId?: string;
  clipId?: string; // Needed for Spline Overlay sync

  minTime?: number;
  duration?: number;
  timeAxis?: GraphTimeAxis;
  disabled?: boolean;
  captureSnapshot?: () => unknown | null;
  restoreSnapshot?: (snapshot: unknown) => void;
}

export const ControlRenderer = memo(function ControlRenderer({
  control,
  value,
  values = {},
  onCommit,
  onCommitMany,
  groupId,
  transformId,
  clipId,
  minTime = 0,
  duration = 10,
  timeAxis,
  disabled = false,
  captureSnapshot,
  restoreSnapshot,
}: ControlRendererProps): ReactElement | null {
  const context = useMemo(
    () =>
      clipId
        ? { contextId: clipId, transformId, property: control.name }
        : undefined,
    [transformId, clipId, control.name],
  );

  if (control.type === "custom") {
    const CustomControl = getCustomControl(control.componentId);
    return CustomControl
      ? createElement(CustomControl, {
          control,
          value,
          values,
          onCommit,
          onCommitMany: onCommitMany ?? (() => undefined),
          groupId,
          transformId,
          disabled,
          sourceTimeRange: { minTime, duration },
          renderParameterControl: (
            parameterControl: ControlDefinition,
          ): ReactElement =>
            createElement(ControlRenderer, {
              control: parameterControl,
              value: values[parameterControl.name],
              values,
              onCommit: (nextValue: unknown, options?: ControlCommitOptions) => {
                const values = { [parameterControl.name]: nextValue };
                if (options) onCommitMany?.(values, options);
                else onCommitMany?.(values);
              },
              onCommitMany,
              groupId,
              transformId,
              clipId,
              minTime,
              duration,
              timeAxis,
              disabled,
              captureSnapshot,
              restoreSnapshot,
            }),
        })
      : null;
  }

  if (control.type === "number") {
    return (
      <ScalarControl
        control={control}
        value={value}
        onCommit={onCommit}
        minTime={minTime}
        duration={duration}
        timeAxis={timeAxis}
        context={context}
        transformId={transformId}
        groupId={groupId}
        captureSnapshot={captureSnapshot}
        restoreSnapshot={restoreSnapshot}
        disabled={disabled}
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
        timeAxis={timeAxis}
        context={context}
        transformId={transformId}
        groupId={groupId}
        captureSnapshot={captureSnapshot}
        restoreSnapshot={restoreSnapshot}
        disabled={disabled}
      />
    );
  }

  if (control.type === "link") {
    return <LinkControl value={value} onCommit={onCommit} disabled={disabled} />;
  }

  if (control.type === "spacer") {
    return <SpacerControl />;
  }

  if (control.type === "text") {
    return (
      <BufferedTextInput
        label={control.label}
        value={
          typeof value === "string"
            ? value
            : String(control.defaultValue ?? "")
        }
        onCommit={onCommit}
        disabled={disabled}
      />
    );
  }

  if (control.type === "color") {
    return (
      <BufferedColorInput
        label={control.label}
        value={
          typeof value === "string"
            ? value
            : String(control.defaultValue ?? "#000000")
        }
        onCommit={onCommit}
        disabled={disabled}
      />
    );
  }

  if (control.type === "select") {
    return (
      <SelectControl
        control={control}
        value={value}
        onCommit={onCommit}
        disabled={disabled}
      />
    );
  }

  if (control.type === "checkbox") {
    return (
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={value === true}
            onChange={(_, checked) => onCommit(checked)}
            disabled={disabled}
          />
        }
        label={control.label}
      />
    );
  }

  return null;
});
