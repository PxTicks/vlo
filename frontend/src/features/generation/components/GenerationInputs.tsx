import { memo, useMemo } from "react";
import {
  Box,
  TextField,
  IconButton,
  Typography,
  MenuItem,
  Slider,
  Checkbox,
  Tooltip,
} from "@mui/material";
import { Casino, InfoOutlined } from "@mui/icons-material";
import { PanelSection, AssetDropSlot, CommittedTextInput } from "../../panelUI";
import type { Asset } from "../../../types/Asset";
import { resolveAssetType } from "../../../shared/utils/assetTypeDetection";
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
import { isAspectRatioWidget } from "../utils/aspectRatioWidgets";

interface GenerationInputsProps {
  inputs: WorkflowInput[];
  textValues: Record<string, string>;
  onTextValueCommit: (inputId: string, value: string) => void;
  mediaInputs: Record<string, GenerationMediaInputValue | null>;
  onInputDrop: (inputId: string, asset: Asset) => void;
  onExternalInputDrop: (inputId: string, file: File) => void | Promise<void>;
  onInputClear: (inputId: string) => void;
  onSwapMediaInputs: (sourceInputId: string, targetInputId: string) => void;
  onClickSelect: (inputId: string, inputType: "image" | "video" | "audio") => void;
  widgetInputs: WorkflowWidgetInput[];
  widgetValues: Record<string, Record<string, unknown>>;
  randomizeToggles: Record<string, boolean>;
  onWidgetChange: (nodeId: string, param: string, value: unknown) => void;
  onToggleRandomize: (nodeId: string, param: string) => void;
  showExactAspectRatioControl?: boolean;
  exactAspectRatioWidgetKey?: string | null;
  exactAspectRatio?: boolean;
  onExactAspectRatioChange?: (exact: boolean) => void;
  exactAspectRatioTooltip?: string;
}

function toSlotValue(
  value: GenerationMediaInputValue | null | undefined,
): AssetDropSlotValue | null {
  if (!value) return null;

  if (value.kind === "asset") {
    const assetType = resolveAssetType(value.asset) ?? value.asset.type;
    return {
      type: assetType,
      name: value.asset.name,
      thumbnail:
        value.asset.thumbnail ||
        (assetType === "image" ? value.asset.src : undefined),
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
    type: value.mediaType,
    name: `Timeline selection (${value.timelineSelection.start}-${value.timelineSelection.end ?? value.timelineSelection.start})`,
    ...(value.mediaType === "video"
      ? { thumbnail: value.thumbnailUrl }
      : {}),
  };
}

function resolveAcceptTypes(
  inputType: WorkflowInput["inputType"],
) {
  switch (inputType) {
    case "image":
      return ["image" as const];
    case "audio":
      return ["audio" as const];
    case "video":
      return ["video" as const];
    default:
      return [];
  }
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

function inferSliderPrecision(step: number | undefined): number {
  if (typeof step !== "number" || !Number.isFinite(step) || step <= 0) {
    return 2;
  }

  const normalized = step.toString();
  if (!normalized.includes(".")) {
    return 0;
  }

  return Math.min(4, normalized.split(".")[1]?.length ?? 0);
}

function formatSliderNumber(
  value: number,
  step: number | undefined,
  unit: string | undefined,
  precisionOverride?: number,
): string {
  const precision = precisionOverride ?? inferSliderPrecision(step);
  const roundedValue =
    precision === 0 ? Math.round(value) : Number(value.toFixed(precision));
  const formatted =
    precision === 0
      ? String(roundedValue)
      : roundedValue.toFixed(precision).replace(/\.?0+$/, "");
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatSliderValue(
  widget: WorkflowWidgetInput,
  value: number,
): string {
  const { displayUnit } = widget.config;
  if (displayUnit) {
    const transformed = value * displayUnit.scale + displayUnit.offset;
    return formatSliderNumber(
      transformed,
      undefined,
      displayUnit.unit,
      displayUnit.precision ?? 0,
    );
  }

  if (
    widget.config.sliderDisplay === "percent" ||
    (widget.config.sliderDisplay == null &&
      widget.kind === "derived" &&
      widget.deriveKind === "dual_sampler_denoise")
  ) {
    return formatSliderPercent(value);
  }

  return formatSliderNumber(value, widget.config.step, widget.config.unit);
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

  type WidgetGroupAccumulator = {
    title: string;
    widgets: GroupedWidget[];
    firstIndex: number;
    minOrder?: number;
  };

  const grouped = new Map<string, WidgetGroupAccumulator>();
  for (const [index, widget] of widgetInputs.entries()) {
    if (isHiddenWidget(widget)) continue;
    const groupId = widget.config.groupId || widget.nodeId;
    const groupTitle = widget.config.groupTitle || widget.config.nodeTitle || "";
    const existing = grouped.get(groupId);
    if (existing) {
      existing.widgets.push({ widget, index });
      if (!existing.title && groupTitle) {
        existing.title = groupTitle;
      }
      if (
        typeof widget.config.groupOrder === "number" &&
        (existing.minOrder === undefined ||
          widget.config.groupOrder < existing.minOrder)
      ) {
        existing.minOrder = widget.config.groupOrder;
      }
      continue;
    }
    grouped.set(groupId, {
      title: groupTitle,
      widgets: [{ widget, index }],
      firstIndex: index,
      minOrder:
        typeof widget.config.groupOrder === "number"
          ? widget.config.groupOrder
          : undefined,
    });
  }

  return Array.from(grouped.entries())
    .sort(([leftId, left], [rightId, right]) => {
      if (
        typeof left.minOrder === "number" &&
        typeof right.minOrder === "number"
      ) {
        if (left.minOrder !== right.minOrder) {
          return left.minOrder - right.minOrder;
        }
      } else if (typeof left.minOrder === "number") {
        return -1;
      } else if (typeof right.minOrder === "number") {
        return 1;
      }

      if (left.firstIndex !== right.firstIndex) {
        return left.firstIndex - right.firstIndex;
      }

      return leftId.localeCompare(rightId);
    })
    .map(([groupId, group]) => {
      const entries = [...group.widgets];
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

      const fallbackTitle =
        entries.length === 1
          ? entries[0]?.widget.config.label || `Node ${groupId}`
          : `Node ${groupId}`;

      return {
        id: groupId,
        title: group.title || fallbackTitle,
        widgets: entries.map((entry) => entry.widget),
      };
    });
}

type RenderableInputBlock =
  | {
      kind: "text";
      input: WorkflowInput;
    }
  | {
      kind: "media";
      input: MediaWorkflowInput;
    }
  | {
      kind: "mediaGroup";
      id: string;
      title: string;
      inputs: MediaWorkflowInput[];
    };

function getRenderableInputBlockPriority(block: RenderableInputBlock): number {
  switch (block.kind) {
    case "media":
    case "mediaGroup":
      return 0;
    case "text":
      return 1;
  }
}

function buildRenderableInputBlocks(inputs: WorkflowInput[]): RenderableInputBlock[] {
  type GroupedInputEntry = {
    input: MediaWorkflowInput;
    index: number;
    order?: number;
  };

  type GroupAccumulator = {
    title: string;
    entries: GroupedInputEntry[];
    minOrder?: number;
    firstIndex: number;
  };

  const blocks: RenderableInputBlock[] = [];
  const groupedEntries = new Map<string, GroupAccumulator>();

  for (const [index, input] of inputs.entries()) {
    if (input.inputType === "text") {
      blocks.push({ kind: "text", input });
      continue;
    }

    if (!isMediaWorkflowInput(input)) {
      continue;
    }

    const mediaInput = input;

    const group = mediaInput.presentation?.group;
    if (!group?.id) {
      blocks.push({ kind: "media", input: mediaInput });
      continue;
    }

    const existing = groupedEntries.get(group.id);
    if (existing) {
      existing.entries.push({ input: mediaInput, index, order: group.order });
      if (
        typeof group.order === "number" &&
        (existing.minOrder === undefined || group.order < existing.minOrder)
      ) {
        existing.minOrder = group.order;
      }
      if (!existing.title && group.title) {
        existing.title = group.title;
      }
      continue;
    }

    groupedEntries.set(group.id, {
      title: group.title ?? mediaInput.label,
      entries: [{ input: mediaInput, index, order: group.order }],
      minOrder: typeof group.order === "number" ? group.order : undefined,
      firstIndex: index,
    });
    blocks.push({
      kind: "mediaGroup",
      id: group.id,
      title: group.title ?? mediaInput.label,
      inputs: [],
    });
  }

  // Sort key resolution:
  //   - mediaGroup: smallest `group.order` declared by any member, falling
  //     back to the index where the group first appeared. This lets rules
  //     drive inter-group order via per-input `group_order` (e.g. Frames
  //     members at 0,1 and Audio members at 10,11 → Frames first), while
  //     un-rules'd workflows keep their original first-occurrence ordering.
  //   - media / text: their position in the inferred input list.
  const resolveSortKey = (
    block: RenderableInputBlock,
    fallbackIndex: number,
  ): number => {
    if (block.kind !== "mediaGroup") return fallbackIndex;
    const group = groupedEntries.get(block.id);
    if (!group) return fallbackIndex;
    return group.minOrder ?? group.firstIndex;
  };

  return blocks
    .map((block, index) => {
      const sortKey = resolveSortKey(block, index);
      if (block.kind !== "mediaGroup") {
        return { block, index, sortKey };
      }

      const group = groupedEntries.get(block.id);
      if (!group) {
        return { block, index, sortKey };
      }

      const sortedInputs = [...group.entries]
        .sort((left, right) => {
          if (
            typeof left.order === "number" &&
            typeof right.order === "number"
          ) {
            if (left.order !== right.order) {
              return left.order - right.order;
            }
            return left.index - right.index;
          }
          if (typeof left.order === "number") return -1;
          if (typeof right.order === "number") return 1;
          return left.index - right.index;
        })
        .map((entry) => entry.input);

      return {
        index,
        sortKey,
        block: {
          ...block,
          title: group.title || block.title,
          inputs: sortedInputs,
        },
      };
    })
    .sort((left, right) => {
      const leftPriority = getRenderableInputBlockPriority(left.block);
      const rightPriority = getRenderableInputBlockPriority(right.block);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      if (left.sortKey !== right.sortKey) {
        return left.sortKey - right.sortKey;
      }
      return left.index - right.index;
    })
    .map(({ block }) => block);
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

type MediaWorkflowInput = WorkflowInput & {
  inputType: "image" | "video" | "audio";
};

function isMediaWorkflowInput(input: WorkflowInput): input is MediaWorkflowInput {
  return (
    input.inputType === "image" ||
    input.inputType === "video" ||
    input.inputType === "audio"
  );
}

interface MediaInputSectionProps {
  input: MediaWorkflowInput;
  bgColor: string;
  value: GenerationMediaInputValue | null | undefined;
  onInputDrop: (inputId: string, asset: Asset) => void;
  onExternalInputDrop: (inputId: string, file: File) => void | Promise<void>;
  onInputClear: (inputId: string) => void;
  onClickSelect: (inputId: string, inputType: "image" | "video" | "audio") => void;
}

function MediaInputSection({
  input,
  bgColor,
  value,
  onInputDrop,
  onExternalInputDrop,
  onInputClear,
  onClickSelect,
}: MediaInputSectionProps) {
  const inputId = getWorkflowInputId(input);
  const mediaInputType = input.inputType;
  const acceptTypes = resolveAcceptTypes(mediaInputType);
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
        onExternalDrop={(file: File) => onExternalInputDrop(inputId, file)}
        onSelect={() => onClickSelect(inputId, mediaInputType)}
      />
    </PanelSection>
  );
}

const MemoizedMediaInputSection = memo(MediaInputSection);

interface MediaInputGroupSectionProps {
  title: string;
  inputs: MediaWorkflowInput[];
  bgColor: string;
  mediaInputs: Record<string, GenerationMediaInputValue | null>;
  onInputDrop: (inputId: string, asset: Asset) => void;
  onExternalInputDrop: (inputId: string, file: File) => void | Promise<void>;
  onInputClear: (inputId: string) => void;
  onSwapMediaInputs: (sourceInputId: string, targetInputId: string) => void;
  onClickSelect: (inputId: string, inputType: "image" | "video" | "audio") => void;
}

function MediaInputGroupSection({
  title,
  inputs,
  bgColor,
  mediaInputs,
  onInputDrop,
  onExternalInputDrop,
  onInputClear,
  onSwapMediaInputs,
  onClickSelect,
}: MediaInputGroupSectionProps) {
  return (
    <PanelSection title={title} bgColor={bgColor} defaultOpen={true}>
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          gap: 1.5,
          alignItems: "flex-start",
        }}
      >
        {inputs.map((input) => {
          const inputId = getWorkflowInputId(input);
          const mediaInputType = input.inputType;
          const acceptTypes = resolveAcceptTypes(mediaInputType);
          const value = getWorkflowInputValue(mediaInputs, input);
          const slotValue = toSlotValue(value);

          return (
            <Box key={inputId} sx={{ display: "flex", flexDirection: "column" }}>
              <AssetDropSlot
                id={inputId}
                label={input.label}
                accept={acceptTypes}
                value={slotValue}
                reorderData={slotValue ? { type: "media-input", inputId } : null}
                onReorderDrop={(data) =>
                  onSwapMediaInputs(data.inputId, inputId)
                }
                onClear={() => onInputClear(inputId)}
                onDrop={(asset: Asset) => onInputDrop(inputId, asset)}
                onExternalDrop={(file: File) =>
                  onExternalInputDrop(inputId, file)
                }
                onSelect={() => onClickSelect(inputId, mediaInputType)}
              />
              {input.description ? (
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    fontSize: "0.7rem",
                    mt: 0.75,
                    maxWidth: 120,
                  }}
                >
                  {input.description}
                </Typography>
              ) : null}
            </Box>
          );
        })}
      </Box>
    </PanelSection>
  );
}

const MemoizedMediaInputGroupSection = memo(MediaInputGroupSection);

interface WidgetRowProps {
  widget: WorkflowWidgetInput;
  value: unknown;
  isRandomized: boolean;
  onWidgetChange: (nodeId: string, param: string, value: unknown) => void;
  onToggleRandomize: (nodeId: string, param: string) => void;
  showExactAspectRatioControl: boolean;
  exactAspectRatio: boolean;
  onExactAspectRatioChange?: (exact: boolean) => void;
  exactAspectRatioTooltip?: string;
}

function WidgetRow({
  widget,
  value,
  isRandomized,
  onWidgetChange,
  onToggleRandomize,
  showExactAspectRatioControl,
  exactAspectRatio,
  onExactAspectRatioChange,
  exactAspectRatioTooltip,
}: WidgetRowProps) {
  const useNumericInput = shouldUseNumericWidgetInput(widget, value);
  const useSelectInput =
    !isRandomized && (isEnumWidget(widget) || isBooleanWidget(widget));
  const isSlider = isSliderWidget(widget);
  const showInlineExactAspectRatioControl =
    showExactAspectRatioControl &&
    typeof onExactAspectRatioChange === "function";
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
            {formatSliderValue(widget, sliderValue)}
          </Typography>
        </Box>
        <Slider
          value={sliderValue}
          min={min}
          max={max}
          step={step}
          valueLabelDisplay="off"
          valueLabelFormat={(nextValue) => formatSliderValue(widget, nextValue)}
          onChange={(_, nextValue) => {
            if (typeof nextValue !== "number") return;
            onWidgetChange(widget.nodeId, widget.param, nextValue);
          }}
          sx={{
            color: "primary.light",
            px: 0.5,
          }}
        />
        {widget.config.description ? (
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", mt: 0.75 }}
          >
            {widget.config.description}
          </Typography>
        ) : null}
      </Box>
    );
  }

  return (
    <Box sx={{ mb: 1 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box sx={{ minWidth: 120, flexShrink: 0 }}>
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
            minWidth: 80,
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
      {showInlineExactAspectRatioControl ? (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            pl: "128px",
            mt: 0.5,
          }}
        >
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              letterSpacing: "0.12em",
            }}
          >
            EXACT
          </Typography>
          <Checkbox
            checked={exactAspectRatio}
            onChange={(event) => onExactAspectRatioChange(event.target.checked)}
            size="small"
            inputProps={{
              "aria-label": "Use exact input aspect ratio",
            }}
            sx={{
              color: "rgba(255, 255, 255, 0.65)",
              p: 0.25,
              "&.Mui-checked": {
                color: "primary.main",
              },
            }}
          />
          {exactAspectRatioTooltip ? (
            <Tooltip title={exactAspectRatioTooltip} arrow>
              <InfoOutlined
                fontSize="inherit"
                aria-label="Exact aspect ratio help"
                sx={{ color: "text.secondary" }}
              />
            </Tooltip>
          ) : null}
        </Box>
      ) : null}
      {widget.config.description ? (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            display: "block",
            mt: 0.75,
          }}
        >
          {widget.config.description}
        </Typography>
      ) : null}
    </Box>
  );
}

const MemoizedWidgetRow = memo(WidgetRow);

interface WidgetGroupSectionProps {
  group: WidgetGroup;
  widgetValues: Record<string, Record<string, unknown>>;
  randomizeToggles: Record<string, boolean>;
  onWidgetChange: (nodeId: string, param: string, value: unknown) => void;
  onToggleRandomize: (nodeId: string, param: string) => void;
  showExactAspectRatioControl: boolean;
  resolvedExactAspectRatioWidgetKey: string | null;
  exactAspectRatio: boolean;
  onExactAspectRatioChange?: (exact: boolean) => void;
  exactAspectRatioTooltip?: string;
  showDivider: boolean;
}

function WidgetGroupSection({
  group,
  widgetValues,
  randomizeToggles,
  onWidgetChange,
  onToggleRandomize,
  showExactAspectRatioControl,
  resolvedExactAspectRatioWidgetKey,
  exactAspectRatio,
  onExactAspectRatioChange,
  exactAspectRatioTooltip,
  showDivider,
}: WidgetGroupSectionProps) {
  return (
    <Box
      sx={{
        pt: showDivider ? 1.5 : 0,
        borderTop: showDivider ? "1px solid rgba(255,255,255,0.08)" : "none",
      }}
    >
      <Typography
        variant="subtitle2"
        sx={{ color: "text.primary", fontWeight: 600, mb: 1 }}
      >
        {group.title}
      </Typography>
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
            showExactAspectRatioControl={
              showExactAspectRatioControl &&
              resolvedExactAspectRatioWidgetKey === key
            }
            exactAspectRatio={exactAspectRatio}
            onExactAspectRatioChange={onExactAspectRatioChange}
            exactAspectRatioTooltip={exactAspectRatioTooltip}
          />
        );
      })}
    </Box>
  );
}

const MemoizedWidgetGroupSection = memo(WidgetGroupSection);

interface SettingsSectionProps {
  bgColor: string;
  groups: WidgetGroup[];
  widgetValues: Record<string, Record<string, unknown>>;
  randomizeToggles: Record<string, boolean>;
  onWidgetChange: (nodeId: string, param: string, value: unknown) => void;
  onToggleRandomize: (nodeId: string, param: string) => void;
  showExactAspectRatioControl: boolean;
  resolvedExactAspectRatioWidgetKey: string | null;
  exactAspectRatio: boolean;
  onExactAspectRatioChange?: (exact: boolean) => void;
  exactAspectRatioTooltip?: string;
}

function SettingsSection({
  bgColor,
  groups,
  widgetValues,
  randomizeToggles,
  onWidgetChange,
  onToggleRandomize,
  showExactAspectRatioControl,
  resolvedExactAspectRatioWidgetKey,
  exactAspectRatio,
  onExactAspectRatioChange,
  exactAspectRatioTooltip,
}: SettingsSectionProps) {
  return (
    <PanelSection title="Settings" bgColor={bgColor} defaultOpen={true}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {groups.map((group, index) => (
          <MemoizedWidgetGroupSection
            key={`settings-group:${group.id}`}
            group={group}
            widgetValues={widgetValues}
            randomizeToggles={randomizeToggles}
            onWidgetChange={onWidgetChange}
            onToggleRandomize={onToggleRandomize}
            showExactAspectRatioControl={showExactAspectRatioControl}
            resolvedExactAspectRatioWidgetKey={resolvedExactAspectRatioWidgetKey}
            exactAspectRatio={exactAspectRatio}
            onExactAspectRatioChange={onExactAspectRatioChange}
            exactAspectRatioTooltip={exactAspectRatioTooltip}
            showDivider={index > 0}
          />
        ))}
      </Box>
    </PanelSection>
  );
}

const MemoizedSettingsSection = memo(SettingsSection);

export const GenerationInputs = memo(function GenerationInputs({
  inputs,
  textValues,
  onTextValueCommit,
  mediaInputs,
  onInputDrop,
  onExternalInputDrop,
  onInputClear,
  onSwapMediaInputs,
  onClickSelect,
  widgetInputs,
  widgetValues,
  randomizeToggles,
  onWidgetChange,
  onToggleRandomize,
  showExactAspectRatioControl = false,
  exactAspectRatioWidgetKey,
  exactAspectRatio = false,
  onExactAspectRatioChange,
  exactAspectRatioTooltip,
}: GenerationInputsProps) {
  const groupedWidgets = useMemo(
    () => groupWidgetsByNode(widgetInputs),
    [widgetInputs],
  );
  const inputBlocks = useMemo(
    () => buildRenderableInputBlocks(inputs),
    [inputs],
  );
  const inputLookup = useMemo(() => buildWorkflowInputLookup(inputs), [inputs]);
  const resolvedExactAspectRatioWidgetKey = useMemo(() => {
    if (exactAspectRatioWidgetKey) {
      return exactAspectRatioWidgetKey;
    }
    const widget = widgetInputs.find(isAspectRatioWidget);
    return widget ? `${widget.nodeId}:${widget.param}` : null;
  }, [exactAspectRatioWidgetKey, widgetInputs]);
  return (
    <Box sx={{ display: "flex", flexDirection: "column" }}>
      {inputBlocks.map((block, index) => {
        const bgColor = index % 2 === 0 ? "#202024" : "#18181b";

        if (block.kind === "text") {
          const input = block.input;
          const inputId = getWorkflowInputId(input);
          const commitInputId =
            inputLookup.get(input.nodeId) === input ? input.nodeId : inputId;

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

        if (block.kind === "mediaGroup") {
          return (
            <MemoizedMediaInputGroupSection
              key={`media-group:${block.id}`}
              title={block.title}
              inputs={block.inputs}
              bgColor={bgColor}
              mediaInputs={mediaInputs}
              onInputDrop={onInputDrop}
              onExternalInputDrop={onExternalInputDrop}
              onInputClear={onInputClear}
              onSwapMediaInputs={onSwapMediaInputs}
              onClickSelect={onClickSelect}
            />
          );
        }

        const input = block.input;
        const inputId = getWorkflowInputId(input);
        return (
          <MemoizedMediaInputSection
            key={inputId}
            input={input}
            bgColor={bgColor}
            value={getWorkflowInputValue(mediaInputs, input, inputLookup)}
            onInputDrop={onInputDrop}
            onExternalInputDrop={onExternalInputDrop}
            onInputClear={onInputClear}
            onClickSelect={onClickSelect}
          />
        );
      })}

      {groupedWidgets.length > 0 ? (
        <MemoizedSettingsSection
          bgColor={inputBlocks.length % 2 === 0 ? "#202024" : "#18181b"}
          groups={groupedWidgets}
          widgetValues={widgetValues}
          randomizeToggles={randomizeToggles}
          onWidgetChange={onWidgetChange}
          onToggleRandomize={onToggleRandomize}
          showExactAspectRatioControl={showExactAspectRatioControl}
          resolvedExactAspectRatioWidgetKey={resolvedExactAspectRatioWidgetKey}
          exactAspectRatio={exactAspectRatio}
          onExactAspectRatioChange={onExactAspectRatioChange}
          exactAspectRatioTooltip={exactAspectRatioTooltip}
        />
      ) : null}
    </Box>
  );
});
