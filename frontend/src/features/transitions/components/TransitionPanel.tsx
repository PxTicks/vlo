import { memo, useCallback, useState, useSyncExternalStore } from "react";
import { Box, Checkbox, FormControlLabel, Typography } from "@mui/material";
import {
  updateTimelineTransitionParameters,
  useSelectedTimelineTransitionId,
  useTimelineTransitions,
} from "../../timeline/api";
import { ControlGroup } from "../../panelUI/components/ControlGroup";
import { NumberControl } from "../../panelUI/components/NumberControl";
import { SelectControl } from "../../panelUI/components/SelectControl";
import { SliderControl } from "../../panelUI/components/SliderControl";
import { BufferedColorInput } from "../../panelUI/components/BufferedColorInput";
import { BufferedTextInput } from "../../panelUI/components/BufferedTextInput";
import type { ControlRenderProps } from "../../panelUI/types";
import {
  getTransitionDefinition,
  getTransitionRegistryRevision,
  subscribeTransitionRegistry,
  validateTransitionParameterUpdates,
} from "../catalogue/TransitionRegistry";

function TransitionSlider({
  control,
  value,
  onCommit,
}: ControlRenderProps) {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof control.defaultValue === "number"
        ? control.defaultValue
        : 0;
  const [localValue, setLocalValue] = useState(numericValue);
  const [lastValue, setLastValue] = useState(numericValue);
  if (lastValue !== numericValue) {
    setLastValue(numericValue);
    setLocalValue(numericValue);
  }

  return (
    <SliderControl
      label={control.label}
      value={localValue}
      min={control.min ?? 0}
      max={control.max ?? 1}
      step={control.step ?? 0.01}
      onChange={(_, next) => setLocalValue(next as number)}
      onChangeCommitted={(_, next) => onCommit(next as number)}
      onInputCommit={(next) => {
        setLocalValue(next);
        onCommit(next);
      }}
    />
  );
}

function TransitionNumber({
  control,
  value,
  onCommit,
}: ControlRenderProps) {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof control.defaultValue === "number"
        ? control.defaultValue
        : 0;
  return (
    <NumberControl
      label={control.label}
      value={numericValue}
      step={control.step}
      onCommit={onCommit}
    />
  );
}

function TransitionPanelComponent() {
  useSyncExternalStore(
    subscribeTransitionRegistry,
    getTransitionRegistryRevision,
    getTransitionRegistryRevision,
  );
  const selectedTransitionId = useSelectedTimelineTransitionId();
  const transitions = useTimelineTransitions();
  const transition = transitions.find(
    (candidate) => candidate.id === selectedTransitionId,
  );

  const renderControl = useCallback((props: ControlRenderProps) => {
    if (props.control.type === "select") {
      return (
        <SelectControl
          control={props.control}
          value={props.value}
          onCommit={props.onCommit}
        />
      );
    }
    if (props.control.type === "slider") {
      return <TransitionSlider {...props} />;
    }
    if (props.control.type === "number") {
      return <TransitionNumber {...props} />;
    }
    if (props.control.type === "color") {
      return (
        <BufferedColorInput
          label={props.control.label}
          value={
            typeof props.value === "string"
              ? props.value
              : String(props.control.defaultValue ?? "#000000")
          }
          onCommit={props.onCommit}
          sx={{ mx: 1 }}
        />
      );
    }
    if (props.control.type === "text") {
      return (
        <BufferedTextInput
          label={props.control.label}
          value={
            typeof props.value === "string"
              ? props.value
              : String(props.control.defaultValue ?? "")
          }
          onCommit={props.onCommit}
        />
      );
    }
    if (props.control.type === "checkbox") {
      return (
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={props.value === true}
              onChange={(_, checked) => props.onCommit(checked)}
            />
          }
          label={props.control.label}
        />
      );
    }
    return null;
  }, []);

  if (!transition) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Select a transition on the timeline.
        </Typography>
      </Box>
    );
  }

  const definition = getTransitionDefinition(transition.type);
  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {definition.label}
      </Typography>
      {definition.uiConfig.groups.map((group) => (
        <ControlGroup
          key={group.id}
          group={group}
          values={transition.parameters}
          onCommit={(_groupId, controlName, value) => {
            const updates = {
              [controlName]: value,
            };
            if (!validateTransitionParameterUpdates(transition, updates)) {
              return;
            }
            updateTimelineTransitionParameters(transition.id, updates);
          }}
          renderControl={renderControl}
        />
      ))}
    </Box>
  );
}

export const TransitionPanel = memo(TransitionPanelComponent);
