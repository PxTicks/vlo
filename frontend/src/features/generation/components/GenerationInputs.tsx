import { memo, useMemo } from "react";
import {
  Box,
  TextField,
  IconButton,
  Typography,
  MenuItem,
  Slider,
} from "@mui/material";
import { Casino } from "@mui/icons-material";
import { PanelSection, AssetDropSlot, CommittedTextInput } from "../../panelUI";
import type { Asset } from "../../../types/Asset";
import type {
  GenerationMediaInputValue,
  WorkflowInput,
  WorkflowWidgetInput,
} from "../types";
import type { AssetDropSlotValue } from "../../panelUI";
import {
  buildWorkflowInputLookup,
  getWorkflowInputId,
  getWorkflowInputValue,
} from "../utils/workflowInputs";

interface GenerationInputsProps {
  inputs: WorkflowInput[];
  textValues: Record<string, string>;
  onTextValueCommit: (inputId: string, value: string) => void;
  mediaInputs: Record<string, GenerationMediaInputValue | null>;
  onInputDrop: (inputId: string, asset: Asset) => void;
  onInputClear: (inputId: string) => void;
  onClickSelect: (inputId: string, inputType: "image" | "video") => void;
  widgetInputs: WorkflowWidgetInput[];
  widgetValues: Record<string, Record<string, unknown>>;
  randomizeToggles: Record<string, boolean>;
  onWidgetChange: (nodeId: string, param: string, value: unknown) => void;
  onToggleRandomize: (nodeId: string, param: string) => void;
}

function toSlotValue(
  value: GenerationMediaInputValue | null | undefined,
): AssetDropSlotValue | null {
  if (!value) return null;

  if (value.kind === "asset") {
    return {
      type: value.asset.type,
      name: value.asset.name,
      thumbnail:
        value.asset.thumbnail ||
        (value.asset.type === "image" ? value.asset.src : undefined),
    };
  }

  if (value.kind === "frame") {
    return {
      type: "image",
      name: value.file.name,
      thumbnail: value.previewUrl,
    };
  }

  return {
    type: "video",
    name: `Timeline selection (${value.timelineSelection.start}-${value.timelineSelection.end ?? value.timelineSelection.start})`,
    thumbnail: value.thumbnailUrl,
  };
}

function isUnsafeIntegerString(raw: string): boolean {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return false;
  try {
    const intValue = BigInt(trimmed);
    return (
      intValue > BigInt(Number.MAX_SAFE_INTEGER) ||
      intValue < BigInt(Number.MIN_SAFE_INTEGER)
    );
  } catch {
    return false;
  }
}

function shouldUseNumericWidgetInput(
  widget: WorkflowWidgetInput,
  value: unknown,
): boolean {
  const valueType = widget.config.valueType;
  const hasExplicitNumericType = valueType === "int" || valueType === "float";
  if (
    valueType &&
    !hasExplicitNumericType &&
    valueType !== "unknown"
  ) {
    return false;
  }

  const hasNumericSource =
    typeof widget.currentValue === "number" ||
    typeof value === "number" ||
    (hasExplicitNumericType && typeof value === "string");
  if (!hasNumericSource) return false;

  const hasUnsafeBounds =
    (typeof widget.config.min === "number" &&
      Number.isInteger(widget.config.min) &&
      !Number.isSafeInteger(widget.config.min)) ||
    (typeof widget.config.max === "number" &&
      Number.isInteger(widget.config.max) &&
      !Number.isSafeInteger(widget.config.max));

  if (hasUnsafeBounds) return false;
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value)
  ) {
    return false;
  }
  if (typeof value === "string" && isUnsafeIntegerString(value)) {
    return false;
  }
  return true;
}

function isEnumWidget(widget: WorkflowWidgetInput): boolean {
  return widget.config.valueType === "enum" && !!widget.config.options?.length;
}

function isBooleanWidget(widget: WorkflowWidgetInput): boolean {
  return widget.config.valueType === "boolean";
}

function isSliderWidget(widget: WorkflowWidgetInput): boolean {
  return widget.config.control === "slider";
}

function formatSliderPercent(value: number): string {
  const percentage = value * 100;
  if (Math.abs(percentage - Math.round(percentage)) < 0.0001) {
    return `${Math.round(percentage)}%`;
  }
  return `${percentage.toFixed(1)}%`;
}

function parseEnumValue(
  raw: string,
  options: Array<string | number | boolean> | undefined,
): unknown {
  if (!options || options.length === 0) return raw;
  const matched = options.find((option) => String(option) === raw);
  return matched ?? raw;
}

function parseWidgetValue(
  raw: string,
  useNumericInput: boolean,
  widget: WorkflowWidgetInput,
): unknown {
  if (isBooleanWidget(widget)) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return raw;
  }
  if (isEnumWidget(widget)) {
    return parseEnumValue(raw, widget.config.options);
  }
  if (!useNumericInput) return raw;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return raw;

  if (/^-?\d+$/.test(trimmed)) {
    if (isUnsafeIntegerString(trimmed)) {
      return trimmed;
    }
    const intValue = Number.parseInt(trimmed, 10);
    if (Number.isNaN(intValue)) return raw;
    if (widget.config.valueType === "float") return Number(intValue);
    return intValue;
  }

  const floatValue = Number.parseFloat(trimmed);
  if (Number.isNaN(floatValue)) return raw;
  if (widget.config.valueType === "int") return raw;
  return floatValue;
}

interface WidgetGroup {
  id: string;
  title: string;
  widgets: WorkflowWidgetInput[];
}

/** Hide frontend-only enum widgets that declare no options (the default is still applied). */
function isHiddenWidget(widget: WorkflowWidgetInput): boolean {
  if (widget.config.hidden === true) {
    return true;
  }
  return (
    widget.config.frontendOnly === true &&
    widget.config.valueType === "enum" &&
    (!widget.config.options || widget.config.options.length === 0)
  );
}

function groupWidgetsByNode(widgetInputs: WorkflowWidgetInput[]): WidgetGroup[] {
  type GroupedWidget = {
    widget: WorkflowWidgetInput;
    index: number;
  };

  const grouped = new Map<string, WidgetGroup>();
  const groupedWidgets = new Map<string, GroupedWidget[]>();
  for (const [index, widget] of widgetInputs.entries()) {
    if (isHiddenWidget(widget)) continue;
    const groupId = widget.config.groupId || widget.nodeId;
    const groupTitle =
      widget.config.groupTitle ||
      widget.config.nodeTitle ||
      `Node ${groupId}`;
    const existing = grouped.get(groupId);
    if (existing) {
      groupedWidgets.get(groupId)?.push({ widget, index });
      continue;
    }
    grouped.set(groupId, {
      id: groupId,
      title: groupTitle,
      widgets: [],
    });
    groupedWidgets.set(groupId, [{ widget, index }]);
  }

  return Array.from(grouped.values()).map((group) => {
    const entries = groupedWidgets.get(group.id) ?? [];
    entries.sort((left, right) => {
      const leftOrder = left.widget.config.groupOrder;
      const rightOrder = right.widget.config.groupOrder;
      if (typeof leftOrder === "number" && typeof rightOrder === "number") {
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return left.index - right.index;
      }
      if (typeof leftOrder === "number") return -1;
      if (typeof rightOrder === "number") return 1;
      return left.index - right.index;
    });

    return {
      ...group,
      widgets: entries.map((entry) => entry.widget),
    };
  });
}

interface TextInputSectionProps {
  input: WorkflowInput;
  bgColor: string;
  value: string;
  commitInputId: string;
  onCommit: (inputId: string, value: string) => void;
}

function TextInputSection({
  input,
  bgColor,
  value,
  commitInputId,
  onCommit,
}: TextInputSectionProps) {
  return (
    <PanelSection title={input.label} bgColor={bgColor} defaultOpen={true}>
      {input.description ? (
        <Typography sx={{ mb: 1, color: "text.secondary", fontSize: "0.8rem" }}>
          {input.description}
        </Typography>
      ) : null}
      <CommittedTextInput
        initialValue={value}
        onCommit={(nextValue) => onCommit(commitInputId, nextValue)}
        multiline={true}
        minRows={2}
        maxRows={6}
        placeholder={`Enter ${input.label.toLowerCase()}...`}
        sx={{
          "& .MuiOutlinedInput-root": {
            bgcolor: "#1a1a1a",
            fontSize: "0.875rem",
          },
        }}
      />
    </PanelSection>
  );
}

const MemoizedTextInputSection = memo(TextInputSection);

interface MediaInputSectionProps {
  input: WorkflowInput;
  bgColor: string;
  value: GenerationMediaInputValue | null | undefined;
  onInputDrop: (inputId: string, asset: Asset) => void;
  onInputClear: (inputId: string) => void;
  onClickSelect: (inputId: string, inputType: "image" | "video") => void;
}

function MediaInputSection({
  input,
  bgColor,
  value,
  onInputDrop,
  onInputClear,
  onClickSelect,
}: MediaInputSectionProps) {
  const inputId = getWorkflowInputId(input);
  const mediaInputType: "image" | "video" =
    input.inputType === "image" ? "image" : "video";
  const acceptTypes =
    mediaInputType === "image" ? ["image" as const] : ["video" as const];
  const slotValue = useMemo(() => toSlotValue(value), [value]);

  return (
    <PanelSection title={input.label} bgColor={bgColor} defaultOpen={true}>
      {input.description ? (
        <Typography sx={{ mb: 1, color: "text.secondary", fontSize: "0.8rem" }}>
          {input.description}
        </Typography>
      ) : null}
      <AssetDropSlot
        id={inputId}
        accept={acceptTypes}
        value={slotValue}
        onClear={() => onInputClear(inputId)}
        onDrop={(asset: Asset) => onInputDrop(inputId, asset)}
        onSelect={() => onClickSelect(inputId, mediaInputType)}
      />
    </PanelSection>
  );
}

const MemoizedMediaInputSection = memo(MediaInputSection);

interface WidgetRowProps {
  widget: WorkflowWidgetInput;
  value: unknown;
  isRandomized: boolean;
  onWidgetChange: (nodeId: string, param: string, value: unknown) => void;
  onToggleRandomize: (nodeId: string, param: string) => void;
}

function WidgetRow({
  widget,
  value,
  isRandomized,
  onWidgetChange,
  onToggleRandomize,
}: WidgetRowProps) {
  const useNumericInput = shouldUseNumericWidgetInput(widget, value);
  const useSelectInput =
    !isRandomized && (isEnumWidget(widget) || isBooleanWidget(widget));
  const isSlider = isSliderWidget(widget);
  const displayValue =
    value === undefined || value === null
      ? isRandomized
        ? "randomized"
        : ""
      : String(value);
  const parsedSliderValue =
    typeof value === "string" ? Number(value) : value;
  const sliderValue =
    typeof parsedSliderValue === "number" && Number.isFinite(parsedSliderValue)
      ? parsedSliderValue
      : typeof widget.currentValue === "number" && Number.isFinite(widget.currentValue)
        ? widget.currentValue
        : typeof widget.config.min === "number"
          ? widget.config.min
          : 0;

  if (isSlider) {
    const min = widget.config.min ?? 0;
    const max = widget.config.max ?? 1;
    const step = widget.config.step ?? 0.01;

    return (
      <Box sx={{ mb: 1.5 }}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            mb: 0.75,
          }}
        >
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block" }}
          >
            {widget.config.label}
          </Typography>
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block" }}
          >
            {formatSliderPercent(sliderValue)}
          </Typography>
        </Box>
        <Slider
          value={sliderValue}
          min={min}
          max={max}
          step={step}
          valueLabelDisplay="off"
          valueLabelFormat={(nextValue) => formatSliderPercent(nextValue)}
          onChange={(_, nextValue) => {
            if (typeof nextValue !== "number") return;
            onWidgetChange(widget.nodeId, widget.param, nextValue);
          }}
          sx={{
            color: "primary.light",
            px: 0.5,
          }}
        />
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
      <Box sx={{ minWidth: 120 }}>
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block" }}
        >
          {widget.config.label}
        </Typography>
      </Box>
      <TextField
        fullWidth
        select={useSelectInput}
        size="small"
        type={useNumericInput && !isRandomized ? "number" : "text"}
        value={displayValue}
        disabled={isRandomized}
        onChange={(event) => {
          onWidgetChange(
            widget.nodeId,
            widget.param,
            parseWidgetValue(event.target.value, useNumericInput, widget),
          );
        }}
        inputProps={{
          ...(useNumericInput && !isRandomized
            ? {
                min: widget.config.min,
                max: widget.config.max,
                step: widget.config.valueType === "int" ? 1 : 0.01,
              }
            : {}),
        }}
        sx={{
          "& .MuiOutlinedInput-root": {
            bgcolor: isRandomized ? "#2a2a30" : "#1a1a1a",
            fontSize: "0.875rem",
          },
        }}
      >
        {useSelectInput &&
          (isBooleanWidget(widget)
            ? [
                <MenuItem key="boolean:true" value="true">
                  true
                </MenuItem>,
                <MenuItem key="boolean:false" value="false">
                  false
                </MenuItem>,
              ]
            : (widget.config.options ?? []).map((option) => (
                <MenuItem key={String(option)} value={String(option)}>
                  {String(option)}
                </MenuItem>
              )))}
      </TextField>
      {widget.config.controlAfterGenerate && (
        <IconButton
          size="small"
          onClick={() => onToggleRandomize(widget.nodeId, widget.param)}
          title={isRandomized ? "Disable randomize" : "Enable randomize"}
          sx={{
            color: isRandomized ? "primary.main" : "text.disabled",
            bgcolor: isRandomized
              ? "rgba(144,202,249,0.12)"
              : "transparent",
            borderRadius: 1,
            p: 0.5,
            "&:hover": {
              bgcolor: isRandomized
                ? "rgba(144,202,249,0.2)"
                : "rgba(255,255,255,0.08)",
            },
          }}
        >
          <Casino sx={{ fontSize: 18 }} />
        </IconButton>
      )}
    </Box>
  );
}

const MemoizedWidgetRow = memo(WidgetRow);

export const GenerationInputs = memo(function GenerationInputs({
  inputs,
  textValues,
  onTextValueCommit,
  mediaInputs,
  onInputDrop,
  onInputClear,
  onClickSelect,
  widgetInputs,
  widgetValues,
  randomizeToggles,
  onWidgetChange,
  onToggleRandomize,
}: GenerationInputsProps) {
  const groupedWidgets = useMemo(
    () => groupWidgetsByNode(widgetInputs),
    [widgetInputs],
  );
  const inputLookup = useMemo(() => buildWorkflowInputLookup(inputs), [inputs]);
  return (
    <Box sx={{ display: "flex", flexDirection: "column" }}>
      {inputs.map((input, index) => {
        const bgColor = index % 2 === 0 ? "#202024" : "#18181b";
        const inputId = getWorkflowInputId(input);
        const commitInputId =
          inputLookup.get(input.nodeId) === input ? input.nodeId : inputId;

        if (input.inputType === "text") {
          return (
            <MemoizedTextInputSection
              key={inputId}
              input={input}
              bgColor={bgColor}
              value={getWorkflowInputValue(textValues, input, inputLookup) ?? ""}
              commitInputId={commitInputId}
              onCommit={onTextValueCommit}
            />
          );
        }

        return (
          <MemoizedMediaInputSection
            key={inputId}
            input={input}
            bgColor={bgColor}
            value={getWorkflowInputValue(mediaInputs, input, inputLookup)}
            onInputDrop={onInputDrop}
            onInputClear={onInputClear}
            onClickSelect={onClickSelect}
          />
        );
      })}

      {groupedWidgets.map((group, index) => {
        const bgColor =
          (inputs.length + index) % 2 === 0 ? "#202024" : "#18181b";

        return (
          <PanelSection
            key={`widgets:${group.id}`}
            title={group.title}
            bgColor={bgColor}
            defaultOpen={true}
          >
            {group.widgets.map((widget) => {
              const key = `${widget.nodeId}:${widget.param}`;
              const nodeValues = widgetValues[widget.nodeId] ?? {};
              const value = nodeValues[widget.param] ?? widget.currentValue;
              const isRandomized = randomizeToggles[key] ?? false;

              return (
                <MemoizedWidgetRow
                  key={key}
                  widget={widget}
                  value={value}
                  isRandomized={isRandomized}
                  onWidgetChange={onWidgetChange}
                  onToggleRandomize={onToggleRandomize}
                />
              );
            })}
          </PanelSection>
        );
      })}
    </Box>
  );
});
