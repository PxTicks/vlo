import { memo, useCallback, useMemo } from "react";
import { Box, Button, Checkbox, IconButton, MenuItem, TextField, Tooltip, Typography } from "@mui/material";
import { Casino, InfoOutlined } from "@mui/icons-material";
import type { Asset } from "../../../types/Asset";
import {
  AssetBatchDropSlot,
  AssetDropSlot,
  type AssetDropSlotDisabledActions,
  BufferedNumberInput,
  BufferedTextInput,
  PanelSection,
  RangeSliderControl,
  SliderControl,
  type AssetBatchSlotItem,
} from "../../panelUI";
import {
  canValueCarryAudio,
  readIncludeEmbeddedAudio,
} from "../utils/mediaInputItemOptions";
import type {
  GenerationMediaInputValue,
  WorkflowInput,
  WorkflowInputItemOption,
  WorkflowWidgetInput,
} from "../types";
import {
  buildRepeatableInputSlotId,
  getWorkflowInputId,
  getWorkflowInputValue,
} from "../utils/workflowInputs";
import { getNodeBypassWidgetKey } from "../utils/nodeBypassWidgets";
import { pairRangeWidgets } from "../utils/rangeWidgetPairs";
import { isPipelineWidgetNodeId } from "../services/workflowRules/pipelineWidgets";
import { MaskCropPaddingControl } from "./MaskCropPaddingControl";
import { SliderWithCustomOverride } from "./SliderWithCustomOverride";
import { useMediaInputPreparationStore } from "../store/useMediaInputPreparationStore";
import { generationTextInputClaims } from "../services/GenerationTextInputClaims";
import { useGenerationTextInputClaim } from "../hooks/useGenerationTextInputClaim";
import {
  acceptAssetForInputType,
  canEditMediaValue,
  resolveAcceptTypes,
  resolveExternalAcceptTypes,
  toPreparingSlotValue,
  toSlotValue,
  type MediaWorkflowInput,
} from "./generationInputFieldValues";

/**
 * The generation panel's own surface id.
 *
 * The panel is the one surface that is always mounted, so it owns the stable
 * name; a staged editor derives its own from whoever opened it.
 */
export const PANEL_SURFACE_ID = "panel";

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

/**
 * String widgets are prompts in practice, so they get the same full-width
 * multiline box the presented text inputs use instead of an inline row field.
 */
function isTextAreaWidget(widget: WorkflowWidgetInput): boolean {
  return (
    widget.config.valueType === "string" &&
    !widget.config.options?.length &&
    widget.config.control !== "slider"
  );
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

function formatSliderPercent(value: number): string {
  const percentage = value * 100;
  if (Math.abs(percentage - Math.round(percentage)) < 0.0001) {
    return `${Math.round(percentage)}%`;
  }
  return `${percentage.toFixed(1)}%`;
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

function parseEnumValue(
  raw: string,
  options: Array<string | number | boolean> | undefined,
): unknown {
  if (!options || options.length === 0) return raw;
  const matched = options.find((option) => String(option) === raw);
  return matched ?? raw;
}

function WidgetDescription({ widget }: { widget: WorkflowWidgetInput }) {
  if (!widget.config.description) return null;
  return (
    <Typography
      variant="caption"
      sx={{ color: "text.secondary", display: "block", mt: 0.75 }}
    >
      {widget.config.description}
    </Typography>
  );
}

function isResolutionLadderWidget(widget: WorkflowWidgetInput): boolean {
  return (widget.config.resolutionLadder?.length ?? 0) > 0;
}

function parseCustomResolution(rawValue: string): number | null {
  const resolution = Number(rawValue.trim());
  if (!Number.isFinite(resolution) || resolution <= 0) return null;
  return Math.round(resolution);
}

/**
 * The stepped resolution control: a slider restricted to the workflow's
 * interpolated rungs, plus a custom field for a short edge off the ladder.
 * The store bounds whatever the custom field commits.
 */
function ResolutionLadderRow({
  widget,
  value,
  onWidgetChange,
  disabled,
}: {
  widget: WorkflowWidgetInput;
  value: unknown;
  onWidgetChange: (nodeId: string, param: string, value: unknown) => void;
  disabled: boolean;
}) {
  const rungs = useMemo(
    () => [...(widget.config.resolutionLadder ?? [])].sort((a, b) => a - b),
    [widget.config.resolutionLadder],
  );
  const parsed = typeof value === "string" ? Number(value) : value;
  const resolution =
    typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0
      ? Math.round(parsed)
      : (rungs[rungs.length - 1] ?? 720);
  const marks = useMemo(
    () => rungs.map((rung) => ({ value: rung, label: String(rung) })),
    [rungs],
  );

  return (
    <Box sx={{ mb: 1.5 }}>
      <SliderWithCustomOverride
        label={widget.config.label}
        value={resolution}
        min={rungs[0] ?? resolution}
        max={rungs[rungs.length - 1] ?? resolution}
        // Restricted values: the thumb can only land on a rung.
        step={null}
        marks={marks}
        isCustom={!rungs.includes(resolution)}
        readout={`${resolution}p`}
        customValue={String(resolution)}
        customAriaLabel="Custom resolution"
        customInputProps={{ min: 1, step: 1 }}
        parseCustom={parseCustomResolution}
        onChange={(nextValue) =>
          onWidgetChange(widget.nodeId, widget.param, nextValue)
        }
        disabled={disabled}
      />
      <WidgetDescription widget={widget} />
    </Box>
  );
}

/** One titled run of widgets, as the panel groups them. */
export interface WidgetGroup {
  id: string;
  sectionId: string;
  title: string;
  widgets: WorkflowWidgetInput[];
}

/**
 * One rendered generation input, shared by the live panel and by any staged
 * editor over the same inputs.
 *
 * These were private to `GenerationInputs`, which meant a second surface over
 * the same inputs — the prompt composer's staged editor — could either import
 * that 30-prop composition root or reimplement the fields and drift from it.
 * They are value-and-callback driven already, so lifting them out costs
 * nothing and is what keeps the two surfaces looking like one panel.
 */

/**
 * Prompt boxes gate the Generate button: a workflow can require the text input
 * before submission is allowed. Committing only on blur left the button grey
 * while the caret was still in the box, and clicking the disabled button moves
 * no focus, so it never un-stuck itself. Commit on a short typing pause too.
 */
export const PROMPT_COMMIT_DEBOUNCE_MS = 250;

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
  // Claims are keyed by the canonical input id, which is what the session
  // publishes and what a claim resolves to; `commitInputId` may be the bare
  // node-id alias the panel writes through.
  const claim = useGenerationTextInputClaim(getWorkflowInputId(input));

  return (
    <PanelSection title={input.label} bgColor={bgColor} defaultOpen={true}>
      {input.description ? (
        <Typography sx={{ mb: 1, color: "text.secondary", fontSize: "0.8rem" }}>
          {input.description}
        </Typography>
      ) : null}
      {claim ? (
        <Box
          sx={{
            mb: 1,
            p: 1,
            borderRadius: 1,
            bgcolor: "rgba(255, 255, 255, 0.04)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            display: "flex",
            alignItems: "flex-start",
            gap: 1,
          }}
        >
          <Typography
            sx={{ flex: 1, color: "text.secondary", fontSize: "0.75rem" }}
          >
            {claim.reason}
          </Typography>
          <Button
            size="small"
            onClick={() =>
              generationTextInputClaims.revoke(getWorkflowInputId(input))
            }
            sx={{ flexShrink: 0, fontSize: "0.7rem", py: 0, minWidth: 0 }}
          >
            Edit anyway
          </Button>
        </Box>
      ) : null}
      <BufferedTextInput
        // Remounted when a claim comes or goes, so the buffered field picks up
        // the composed text instead of redisplaying the draft it was holding.
        key={claim ? "claimed" : "free"}
        value={value}
        disabled={claim !== null}
        onCommit={(nextValue) => onCommit(commitInputId, nextValue)}
        commitDebounceMs={PROMPT_COMMIT_DEBOUNCE_MS}
        multiline={true}
        minRows={6}
        maxRows={20}
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

export const MemoizedTextInputSection = memo(TextInputSection);

interface MediaInputSectionProps {
  /**
   * The surface these fields are drawn on — `"panel"` for the generation
   * panel, a per-draft id for a staged editor. Namespaces the slots' drag
   * registrations so two surfaces showing the same input do not collide.
   */
  surfaceId: string;

  input: MediaWorkflowInput;
  bgColor: string;
  value: GenerationMediaInputValue | null | undefined;
  onInputDrop: (inputId: string, asset: Asset) => void;
  onExternalInputDrop: (inputId: string, file: File) => void | Promise<void>;
  onInputClear: (inputId: string) => void;
  onClickSelect: (inputId: string, inputType: "image" | "video" | "audio") => void;
  onEditMedia?: (
    inputId: string,
    inputType: "video" | "audio",
  ) => void;
  /** Actions to render refused, with the reason. See the staged editor. */
  disabledActions?: AssetDropSlotDisabledActions;
  /**
   * Narrows which assets the slot accepts, on top of its input type's own
   * rule. The panel accepts a *video* on an image slot because dropping one
   * opens a frame picker; a surface that cannot run that flow has to refuse
   * the drag rather than accept it and stage something else.
   */
  acceptAsset?: (asset: Asset) => boolean;
}

function MediaInputSection({
  surfaceId,
  input,
  bgColor,
  value,
  onInputDrop,
  onExternalInputDrop,
  onInputClear,
  onClickSelect,
  onEditMedia,
  disabledActions,
  acceptAsset: acceptAssetOverride,
}: MediaInputSectionProps) {
  const inputId = getWorkflowInputId(input);
  const mediaInputType = input.inputType;
  const acceptTypes = resolveAcceptTypes(mediaInputType);
  // The caller's rule narrows the input type's own; it never widens it.
  const defaultAcceptAsset = acceptAssetForInputType(mediaInputType);
  const acceptAsset = acceptAssetOverride
    ? (asset: Asset) =>
        (defaultAcceptAsset?.(asset) ?? false) && acceptAssetOverride(asset)
    : defaultAcceptAsset;
  const acceptExternalTypes = resolveExternalAcceptTypes(mediaInputType);
  const preparing = useMediaInputPreparationStore((state) =>
    state.preparingInputIds.has(inputId),
  );
  const slotValue = useMemo(() => {
    const base = toSlotValue(value, mediaInputType);
    return preparing ? toPreparingSlotValue(base, mediaInputType) : base;
  }, [mediaInputType, preparing, value]);
  // Narrowed for the edit callback: only these two have an editor at all.
  const editableMediaType =
    mediaInputType === "video" || mediaInputType === "audio"
      ? mediaInputType
      : null;
  const isEditableMedia = canEditMediaValue(value, mediaInputType);

  return (
    <PanelSection title={input.label} bgColor={bgColor} defaultOpen={true}>
      {input.description ? (
        <Typography sx={{ mb: 1, color: "text.secondary", fontSize: "0.8rem" }}>
          {input.description}
        </Typography>
      ) : null}
      <AssetDropSlot
        surfaceId={surfaceId}
        disabledActions={disabledActions}
        id={inputId}
        accept={acceptTypes}
        acceptAsset={acceptAsset}
        acceptExternal={acceptExternalTypes}
        value={slotValue}
        onClear={() => onInputClear(inputId)}
        onEdit={
          editableMediaType && isEditableMedia && slotValue && !preparing && onEditMedia
            ? () => onEditMedia(inputId, editableMediaType)
            : undefined
        }
        onDrop={(asset: Asset) => onInputDrop(inputId, asset)}
        onExternalDrop={(file: File) => onExternalInputDrop(inputId, file)}
        onSelect={() => onClickSelect(inputId, mediaInputType)}
      />
    </PanelSection>
  );
}

export const MemoizedMediaInputSection = memo(MediaInputSection);

interface BatchMediaInputSectionProps {
  /**
   * The surface these fields are drawn on — `"panel"` for the generation
   * panel, a per-draft id for a staged editor. Namespaces the slots' drag
   * registrations so two surfaces showing the same input do not collide.
   */
  surfaceId: string;

  input: MediaWorkflowInput;
  bgColor: string;
  mediaInputs: Record<string, GenerationMediaInputValue | null>;
  firstValue: GenerationMediaInputValue | null | undefined;
  onInputDrop: (inputId: string, asset: Asset) => void;
  onExternalInputDrop: (inputId: string, file: File) => void | Promise<void>;
  onInputClear: (inputId: string) => void;
  onMoveMediaInput: (sourceInputId: string, targetIndex: number) => void;
  onSwapMediaInputs: (sourceInputId: string, targetInputId: string) => void;
  onClickSelect: (inputId: string, inputType: "image" | "video" | "audio") => void;
  onEditMedia?: (
    inputId: string,
    inputType: "video" | "audio",
  ) => void;
  onToggleItemOption?: (
    inputId: string,
    option: WorkflowInputItemOption,
    active: boolean,
  ) => void;
  /** Actions to render refused, with the reason. See the staged editor. */
  disabledActions?: AssetDropSlotDisabledActions;
}

/**
 * A batch loader presented as one telescoping slot rather than a row of fixed
 * slots: the strip holds exactly the references that were added, in the order
 * the node will receive them, and offers a `+` while it is below its ceiling.
 */
function BatchMediaInputSection({
  surfaceId,
  input,
  bgColor,
  mediaInputs,
  firstValue,
  onInputDrop,
  onExternalInputDrop,
  onInputClear,
  onMoveMediaInput,
  onSwapMediaInputs,
  onClickSelect,
  onEditMedia,
  onToggleItemOption,
  disabledActions,
}: BatchMediaInputSectionProps) {
  const max = Math.max(1, Math.floor(input.presentation?.repeatable?.max ?? 1));
  const mediaInputType = input.inputType;
  const itemOptions = input.presentation?.repeatable?.itemOptions;
  const supportsAudioOption =
    mediaInputType === "video" && itemOptions?.includes("audio") === true;
  // Which *items* offer the pencil is decided per item below; the strip only
  // needs to know whether this media type has an editor at all.
  const editableMediaType =
    mediaInputType === "video" || mediaInputType === "audio"
      ? mediaInputType
      : null;
  const slotLabelBase =
    input.label.replace(/\s+inputs?$/i, "").trim() || input.label;

  const preparingInputIds = useMediaInputPreparationStore(
    (state) => state.preparingInputIds,
  );

  const items = useMemo<AssetBatchSlotItem[]>(() => {
    const collected: AssetBatchSlotItem[] = [];
    for (let index = 0; index < max; index += 1) {
      const slotId = buildRepeatableInputSlotId(input, index);
      const value = index === 0 ? firstValue : mediaInputs[slotId];
      const preparing = preparingInputIds.has(slotId);
      const slotValue = toSlotValue(value, mediaInputType);
      // A position being prepared holds the place it will occupy, so the strip
      // shows the work rather than staying one tile short until it finishes.
      if (preparing) {
        collected.push({
          slotId,
          value: toPreparingSlotValue(slotValue, mediaInputType),
        });
        continue;
      }
      if (!value || !slotValue) continue;
      collected.push({
        slotId,
        value: slotValue,
        editable: canEditMediaValue(value, mediaInputType),
        ...(supportsAudioOption && canValueCarryAudio(value)
          ? {
              options: [
                {
                  id: "audio",
                  icon: "audio" as const,
                  active: readIncludeEmbeddedAudio(value),
                  label: "Include this video's audio as a reference",
                  activeLabel: "Audio included as a reference",
                },
              ],
            }
          : {}),
      });
    }
    return collected;
  }, [
    firstValue,
    input,
    max,
    mediaInputs,
    mediaInputType,
    preparingInputIds,
    supportsAudioOption,
  ]);

  /**
   * Maps a strip position to the slot that backs it. Filled positions answer
   * with their own slot; the trailing add tile answers with the first free
   * slot, so a drop can never land on top of an occupied one even if the batch
   * somehow holds a gap.
   */
  const slotIdAt = useCallback(
    (index: number) => {
      const item = items[index];
      if (item) return item.slotId;
      for (let candidate = 0; candidate < max; candidate += 1) {
        const slotId = buildRepeatableInputSlotId(input, candidate);
        const value = candidate === 0 ? firstValue : mediaInputs[slotId];
        // A slot that is still being prepared counts as taken: its value is on
        // its way and would otherwise be overwritten by the next drop.
        if (!value && !preparingInputIds.has(slotId)) return slotId;
      }
      return buildRepeatableInputSlotId(input, max - 1);
    },
    [firstValue, input, items, max, mediaInputs, preparingInputIds],
  );

  /**
   * A drag can also arrive from another input's slot, which is a swap between
   * two inputs rather than a move inside this batch. Route it the way it was
   * routed before batches were a single slot.
   */
  const ownSlotIds = useMemo(() => {
    const ids = new Set<string>([getWorkflowInputId(input), input.nodeId]);
    for (let index = 0; index < max; index += 1) {
      ids.add(buildRepeatableInputSlotId(input, index));
    }
    return ids;
  }, [input, max]);

  const handleReorder = useCallback(
    (slotId: string, toIndex: number) => {
      if (ownSlotIds.has(slotId)) {
        onMoveMediaInput(slotId, toIndex);
        return;
      }
      onSwapMediaInputs(slotId, slotIdAt(Math.min(toIndex, items.length)));
    },
    [items.length, onMoveMediaInput, onSwapMediaInputs, ownSlotIds, slotIdAt],
  );

  return (
    <PanelSection title={input.label} bgColor={bgColor} defaultOpen={true}>
      {input.description ? (
        <Typography sx={{ mb: 1, color: "text.secondary", fontSize: "0.8rem" }}>
          {input.description}
        </Typography>
      ) : null}
      <AssetBatchDropSlot
        surfaceId={surfaceId}
        disabledActions={disabledActions}
        id={getWorkflowInputId(input)}
        accept={resolveAcceptTypes(mediaInputType)}
        acceptAsset={acceptAssetForInputType(mediaInputType)}
        acceptExternal={resolveExternalAcceptTypes(mediaInputType)}
        items={items}
        max={max}
        itemLabel={(index) => `${slotLabelBase} ${index + 1}`}
        onDrop={(index, asset) => onInputDrop(slotIdAt(index), asset)}
        onExternalDrop={(index, file) =>
          onExternalInputDrop(slotIdAt(index), file)
        }
        onSelect={(index) => onClickSelect(slotIdAt(index), mediaInputType)}
        onClear={(slotId) => onInputClear(slotId)}
        onEdit={
          editableMediaType && onEditMedia
            ? (slotId) => onEditMedia(slotId, editableMediaType)
            : undefined
        }
        onReorder={handleReorder}
        onToggleOption={
          supportsAudioOption && onToggleItemOption
            ? (slotId, optionId, nextActive) =>
                onToggleItemOption(
                  slotId,
                  optionId as WorkflowInputItemOption,
                  nextActive,
                )
            : undefined
        }
      />
    </PanelSection>
  );
}

export const MemoizedBatchMediaInputSection = memo(BatchMediaInputSection);

interface MediaInputGroupSectionProps {
  /**
   * The surface these fields are drawn on — `"panel"` for the generation
   * panel, a per-draft id for a staged editor. Namespaces the slots' drag
   * registrations so two surfaces showing the same input do not collide.
   */
  surfaceId: string;

  title: string;
  inputs: MediaWorkflowInput[];
  bgColor: string;
  mediaInputs: Record<string, GenerationMediaInputValue | null>;
  onInputDrop: (inputId: string, asset: Asset) => void;
  onExternalInputDrop: (inputId: string, file: File) => void | Promise<void>;
  onInputClear: (inputId: string) => void;
  onSwapMediaInputs: (sourceInputId: string, targetInputId: string) => void;
  onClickSelect: (inputId: string, inputType: "image" | "video" | "audio") => void;
  onEditMedia?: (
    inputId: string,
    inputType: "video" | "audio",
  ) => void;
  disabledActions?: AssetDropSlotDisabledActions;
  acceptAsset?: (asset: Asset) => boolean;
}

function MediaInputGroupSection({
  surfaceId,
  title,
  inputs,
  bgColor,
  mediaInputs,
  onInputDrop,
  onExternalInputDrop,
  onInputClear,
  onSwapMediaInputs,
  onClickSelect,
  onEditMedia,
  disabledActions,
  acceptAsset,
}: MediaInputGroupSectionProps) {
  const preparingInputIds = useMediaInputPreparationStore(
    (state) => state.preparingInputIds,
  );

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
          const editableMediaType =
            mediaInputType === "video" || mediaInputType === "audio"
              ? mediaInputType
              : null;
          const acceptTypes = resolveAcceptTypes(mediaInputType);
          const value = getWorkflowInputValue(mediaInputs, input);
          const preparing = preparingInputIds.has(inputId);
          const baseSlotValue = toSlotValue(value, mediaInputType);
          const slotValue = preparing
            ? toPreparingSlotValue(baseSlotValue, mediaInputType)
            : baseSlotValue;

          return (
            <Box key={inputId} sx={{ display: "flex", flexDirection: "column" }}>
              <AssetDropSlot
                surfaceId={surfaceId}
                disabledActions={disabledActions}
                id={inputId}
                label={input.label}
                accept={acceptTypes}
                acceptAsset={(asset) =>
                  (acceptAssetForInputType(mediaInputType)?.(asset) ?? false) &&
                  (acceptAsset?.(asset) ?? true)
                }
                acceptExternal={resolveExternalAcceptTypes(mediaInputType)}
                value={slotValue}
                reorderData={
                  slotValue && !preparing
                    ? { type: "media-input", inputId }
                    : null
                }
                onReorderDrop={(data) =>
                  onSwapMediaInputs(data.inputId, inputId)
                }
                onClear={() => onInputClear(inputId)}
                onEdit={
                  editableMediaType &&
                  canEditMediaValue(value, mediaInputType) &&
                  slotValue &&
                  !preparing &&
                  onEditMedia
                    ? () => onEditMedia(inputId, editableMediaType)
                    : undefined
                }
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

export const MemoizedMediaInputGroupSection = memo(MediaInputGroupSection);

interface WidgetRowProps {
  widget: WorkflowWidgetInput;
  value: unknown;
  isRandomized: boolean;
  /** This widget's node is switched off, so its value changes nothing. */
  nodeBypassed: boolean;
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
  nodeBypassed,
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
  const isTextArea = !isRandomized && !useSelectInput && isTextAreaWidget(widget);
  // Numbers are typed through forms that are not numbers yet ("0.0", "-"), and
  // a field that re-rendered the parsed value on every keystroke would rewrite
  // them mid-edit ("0.05" became "5"). Buffer the text; commit on Enter/blur.
  const useBufferedNumericInput =
    useNumericInput && !isRandomized && !useSelectInput;
  const showInlineExactAspectRatioControl =
    showExactAspectRatioControl &&
    typeof onExactAspectRatioChange === "function";
  const displayValue =
    value === undefined || value === null
      ? isRandomized
        ? "randomized"
        : ""
      : String(value);
  const hasOutOfRangeEnumValue =
    isEnumWidget(widget) &&
    displayValue.length > 0 &&
    displayValue !== widget.config.nodeBypassOption?.value &&
    !(widget.config.options ?? []).some(
      (option) => String(option) === displayValue,
    );
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

  if (!isRandomized && isResolutionLadderWidget(widget)) {
    return (
      <ResolutionLadderRow
        widget={widget}
        value={value}
        onWidgetChange={onWidgetChange}
        disabled={nodeBypassed}
      />
    );
  }

  if (isPipelineWidgetNodeId(widget.nodeId) && widget.param === "crop_dilation") {
    return (
      <Box sx={{ mb: 1.5 }}>
        <MaskCropPaddingControl
          label={widget.config.label}
          value={sliderValue}
          disabled={nodeBypassed}
          onChange={(nextValue) =>
            onWidgetChange(widget.nodeId, widget.param, nextValue)
          }
        />
        <WidgetDescription widget={widget} />
      </Box>
    );
  }

  if (isSlider) {
    return (
      <Box sx={{ mb: 1.5 }}>
        <SliderControl
          label={widget.config.label}
          value={sliderValue}
          min={widget.config.min ?? 0}
          max={widget.config.max ?? 1}
          step={widget.config.step ?? 0.01}
          formatValue={(nextValue) => formatSliderValue(widget, nextValue)}
          disabled={nodeBypassed}
          onChange={(_, nextValue) => {
            if (typeof nextValue !== "number") return;
            onWidgetChange(widget.nodeId, widget.param, nextValue);
          }}
        />
        <WidgetDescription widget={widget} />
      </Box>
    );
  }

  if (isTextArea) {
    // The group heading already carries the name when they match (e.g. a
    // "Prompt" widget alone in a "Prompt" group), so skip the repeat.
    const showLabel =
      widget.config.label.trim().toLowerCase() !==
      (widget.config.groupTitle ?? "").trim().toLowerCase();

    return (
      <Box sx={{ mb: 1 }}>
        {showLabel ? (
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", mb: 0.5 }}
          >
            {widget.config.label}
          </Typography>
        ) : null}
        <BufferedTextInput
          value={displayValue}
          disabled={nodeBypassed}
          onCommit={(nextValue) => {
            onWidgetChange(widget.nodeId, widget.param, nextValue);
          }}
          commitDebounceMs={PROMPT_COMMIT_DEBOUNCE_MS}
          multiline={true}
          minRows={6}
          maxRows={20}
          placeholder={`Enter ${widget.config.label.toLowerCase()}...`}
          sx={{
            "& .MuiOutlinedInput-root": {
              bgcolor: "#1a1a1a",
              fontSize: "0.875rem",
            },
          }}
        />
        <WidgetDescription widget={widget} />
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
        {useBufferedNumericInput ? (
          <BufferedNumberInput
            value={displayValue}
            disabled={nodeBypassed}
            onCommit={(nextValue) => {
              onWidgetChange(
                widget.nodeId,
                widget.param,
                parseWidgetValue(nextValue, useNumericInput, widget),
              );
            }}
            inputProps={{
              min: widget.config.min,
              max: widget.config.max,
              step: widget.config.valueType === "int" ? 1 : 0.01,
            }}
            sx={{
              minWidth: 80,
              "& .MuiOutlinedInput-root": {
                bgcolor: "#1a1a1a",
                fontSize: "0.875rem",
              },
            }}
          />
        ) : (
          <TextField
            fullWidth
            select={useSelectInput}
            size="small"
            value={displayValue}
            disabled={isRandomized || nodeBypassed}
            onChange={(event) => {
              onWidgetChange(
                widget.nodeId,
                widget.param,
                parseWidgetValue(event.target.value, useNumericInput, widget),
              );
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
                : [
                    ...(widget.config.nodeBypassOption
                      ? [
                          <MenuItem
                            key="node-bypass-option"
                            value={widget.config.nodeBypassOption.value}
                          >
                            {widget.config.nodeBypassOption.label}
                          </MenuItem>,
                        ]
                      : []),
                    ...(widget.config.options ?? []).map((option) => (
                      <MenuItem key={String(option)} value={String(option)}>
                        {widget.config.optionLabels?.[String(option)] ??
                          String(option)}
                      </MenuItem>
                    )),
                    ...(hasOutOfRangeEnumValue
                      ? [
                          <MenuItem
                            key="out-of-range-enum-value"
                            value={displayValue}
                            disabled={true}
                          >
                            {displayValue} (unavailable)
                          </MenuItem>,
                        ]
                      : []),
                  ])}
          </TextField>
        )}

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
      <WidgetDescription widget={widget} />
    </Box>
  );
}

const MemoizedWidgetRow = memo(WidgetRow);

function toSliderNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed)
    ? parsed
    : fallback;
}

interface RangeWidgetRowProps {
  low: WorkflowWidgetInput;
  high: WorkflowWidgetInput;
  lowValue: unknown;
  highValue: unknown;
  disabled: boolean;
  onWidgetChange: (nodeId: string, param: string, value: unknown) => void;
}

/**
 * Two slider widgets whose rules pair them as a start/end range.
 *
 * Each end keeps its own bounds (which may follow another widget, like the
 * step count) and its own workflow value; the shared track only adds the rule
 * that the ends stay ordered.
 */
function RangeWidgetRow({
  low,
  high,
  lowValue,
  highValue,
  disabled,
  onWidgetChange,
}: RangeWidgetRowProps) {
  const pairing = low.config.range;
  const min = Math.min(low.config.min ?? 0, high.config.min ?? 0);
  const max = Math.max(low.config.max ?? 1, high.config.max ?? 1);
  const stored: [number, number] = [
    toSliderNumber(lowValue, toSliderNumber(low.currentValue, min)),
    toSliderNumber(highValue, toSliderNumber(high.currentValue, min)),
  ];
  const collapsedLabel = pairing?.collapsedLabel;

  return (
    <Box sx={{ mb: 1.5 }}>
      <RangeSliderControl
        label={pairing?.label ?? low.config.label}
        value={stored}
        min={min}
        max={max}
        step={low.config.step ?? high.config.step ?? 0.01}
        minDistance={pairing?.minDistance ?? 0}
        lowLimits={{ min: low.config.min, max: low.config.max }}
        highLimits={{ min: high.config.min, max: high.config.max }}
        endLabels={[low.config.label, high.config.label]}
        formatValue={(value) => formatSliderValue(low, value)}
        formatReadout={([start, end]) => {
          const startText = formatSliderValue(low, start);
          if (collapsedLabel && end <= start) {
            return `${startText} · ${collapsedLabel}`;
          }
          return `${startText} – ${formatSliderValue(high, end)}`;
        }}
        disabled={disabled}
        onChange={(next, end) => {
          // Only the dragged end is written. A stored end below the start is
          // drawn collapsed, and writing that drawn value back would turn an
          // empty range (which the workflow may treat as its own setting)
          // into a real one the user never asked for.
          if (end === "low") {
            onWidgetChange(low.nodeId, low.param, next[0]);
          } else {
            onWidgetChange(high.nodeId, high.param, next[1]);
          }
        }}
      />
      <WidgetDescription widget={low} />
    </Box>
  );
}

const MemoizedRangeWidgetRow = memo(RangeWidgetRow);

interface WidgetGroupSectionProps {
  group: WidgetGroup;
  widgetValues: Record<string, Record<string, unknown>>;
  bypassedWidgetTargets: ReadonlySet<string>;
  randomizeToggles: Record<string, boolean>;
  onWidgetChange: (nodeId: string, param: string, value: unknown) => void;
  onToggleRandomize: (nodeId: string, param: string) => void;
  showExactAspectRatioControl: boolean;
  resolvedExactAspectRatioWidgetKey: string | null;
  exactAspectRatio: boolean;
  onExactAspectRatioChange?: (exact: boolean) => void;
  exactAspectRatioTooltip?: string;
  showDivider: boolean;
  /** Nodes the panel has switched off through their bypass choice. */
  bypassedNodeIds: ReadonlySet<string>;
}

function WidgetGroupSection({
  group,
  widgetValues,
  bypassedWidgetTargets,
  randomizeToggles,
  onWidgetChange,
  onToggleRandomize,
  showExactAspectRatioControl,
  resolvedExactAspectRatioWidgetKey,
  exactAspectRatio,
  onExactAspectRatioChange,
  exactAspectRatioTooltip,
  showDivider,
  bypassedNodeIds,
}: WidgetGroupSectionProps) {
  const rows = useMemo(() => pairRangeWidgets(group.widgets), [group.widgets]);
  // A node switched off through its bypass choice keeps its remaining
  // controls on screen — the panel would otherwise give no sign they
  // exist — but greyed out, since this run leaves the node out.
  const isNodeBypassed = (widget: WorkflowWidgetInput): boolean =>
    !widget.config.nodeBypassOption && bypassedNodeIds.has(widget.nodeId);
  const widgetValue = (widget: WorkflowWidgetInput): unknown =>
    bypassedWidgetTargets.has(
      getNodeBypassWidgetKey(widget.nodeId, widget.param),
    )
      ? widget.config.nodeBypassOption?.value
      : (widgetValues[widget.nodeId]?.[widget.param] ?? widget.currentValue);

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
      {rows.map((row) => {
        if (row.kind === "range") {
          const { low, high } = row;
          return (
            <MemoizedRangeWidgetRow
              key={`${low.nodeId}:${low.param}~${high.nodeId}:${high.param}`}
              low={low}
              high={high}
              lowValue={widgetValue(low)}
              highValue={widgetValue(high)}
              disabled={isNodeBypassed(low) || isNodeBypassed(high)}
              onWidgetChange={onWidgetChange}
            />
          );
        }

        const { widget } = row;
        const key = `${widget.nodeId}:${widget.param}`;
        const nodeBypassed = isNodeBypassed(widget);
        const value = widgetValue(widget);
        const isRandomized = randomizeToggles[key] ?? false;

        return (
          <MemoizedWidgetRow
            key={key}
            widget={widget}
            value={value}
            isRandomized={isRandomized}
            nodeBypassed={nodeBypassed}
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

export const MemoizedWidgetGroupSection = memo(WidgetGroupSection);
