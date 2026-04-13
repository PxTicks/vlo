import type { WorkflowRules } from "./services/workflowRules/types";
import {
  getMaskProcessingStage,
  getWorkflowStageControl,
} from "./services/workflowRules/pipeline";

export type DerivedMaskSourceVideoTreatment =
  | "preserve_transparency"
  | "fill_transparent_with_neutral_gray"
  | "remove_transparency";

export const DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM =
  "derived_mask_source_video_treatment";
export const LEGACY_DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM =
  "__derived_mask_video_treatment";
export const DERIVED_MASK_VIDEO_TREATMENT_WIDGET_PARAM =
  DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM;
export const DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM_ALIASES = [
  DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM,
  LEGACY_DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM,
] as const;

const DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OVERRIDE_OPERATORS = new Set([
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
]);

export const DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT: DerivedMaskSourceVideoTreatment =
  "preserve_transparency";

interface DerivedMaskVideoTreatmentWidgetLike {
  nodeId: string;
  param: string;
  currentValue: unknown;
  config: {
    frontendOnly?: boolean;
  };
}

interface DerivedMaskSourceLike {
  sourceNodeId: string;
}

interface ResolveDefaultDerivedMaskSourceVideoTreatmentOptions {
  workflow?: Record<string, unknown> | null;
  widgetInputs?: readonly DerivedMaskVideoTreatmentWidgetLike[];
  widgetValues?: Record<string, Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeTreatmentValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function parseDerivedMaskSourceVideoTreatmentOrNull(
  value: unknown,
): DerivedMaskSourceVideoTreatment | null {
  const normalized = normalizeTreatmentValue(value);

  if (
    normalized === "fill_transparent_with_neutral_gray" ||
    normalized === "fill transparent with neutral gray" ||
    normalized === "fill transparent with neutral grey"
  ) {
    return "fill_transparent_with_neutral_gray";
  }

  if (
    normalized === "remove_transparency" ||
    normalized === "remove transparency"
  ) {
    return "remove_transparency";
  }

  if (
    normalized === "preserve_transparency" ||
    normalized === "keep transparency" ||
    normalized === "preserve transparency"
  ) {
    return "preserve_transparency";
  }

  return null;
}

function coerceNumericConditionValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareConditionValue(
  current: unknown,
  operator: string,
  expected: unknown,
): boolean {
  if (operator === "lt" || operator === "lte" || operator === "gt" || operator === "gte") {
    const currentNumber = coerceNumericConditionValue(current);
    const expectedNumber = coerceNumericConditionValue(expected);
    if (currentNumber === null || expectedNumber === null) {
      return false;
    }
    if (operator === "lt") {
      return currentNumber < expectedNumber;
    }
    if (operator === "lte") {
      return currentNumber <= expectedNumber;
    }
    if (operator === "gt") {
      return currentNumber > expectedNumber;
    }
    return currentNumber >= expectedNumber;
  }

  const currentNumber = coerceNumericConditionValue(current);
  const expectedNumber = coerceNumericConditionValue(expected);
  let matches: boolean;

  if (currentNumber !== null && expectedNumber !== null) {
    matches = Math.abs(currentNumber - expectedNumber) <= 1e-9;
  } else if (typeof current === "string" && typeof expected === "string") {
    matches = current.trim().toLowerCase() === expected.trim().toLowerCase();
  } else {
    matches = Object.is(current, expected);
  }

  return operator === "neq" ? !matches : matches;
}

function resolveWorkflowParamValue(
  nodeId: string,
  param: string,
  options: ResolveDefaultDerivedMaskSourceVideoTreatmentOptions,
): unknown {
  const nodeValues = options.widgetValues?.[nodeId];
  if (nodeValues && hasOwnKey(nodeValues, param)) {
    return nodeValues[param];
  }

  const widget = options.widgetInputs?.find(
    (candidate) => candidate.nodeId === nodeId && candidate.param === param,
  );
  if (widget) {
    return widget.currentValue;
  }

  const workflowNode = options.workflow?.[nodeId];
  if (!isRecord(workflowNode)) {
    return undefined;
  }
  const inputs = workflowNode.inputs;
  if (!isRecord(inputs) || !hasOwnKey(inputs, param)) {
    return undefined;
  }
  return inputs[param];
}

export function isDerivedMaskSourceVideoTreatmentWidgetParam(
  param: string,
): boolean {
  return DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM_ALIASES.includes(
    param as (typeof DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM_ALIASES)[number],
  );
}

export function parseDerivedMaskSourceVideoTreatment(
  value: unknown,
): DerivedMaskSourceVideoTreatment {
  return (
    parseDerivedMaskSourceVideoTreatmentOrNull(value) ??
    DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT
  );
}

export function resolveDefaultDerivedMaskSourceVideoTreatment(
  rules: WorkflowRules | null | undefined,
  options: ResolveDefaultDerivedMaskSourceVideoTreatmentOptions = {},
): DerivedMaskSourceVideoTreatment {
  const sourceVideoTreatment = getWorkflowStageControl(
    getMaskProcessingStage(rules),
    "source_video_treatment",
  );
  const defaultTreatment = parseDerivedMaskSourceVideoTreatment(
    sourceVideoTreatment?.default,
  );

  for (const override of sourceVideoTreatment?.default_rules ?? []) {
    const when = override.when;
    if (
      when?.ref?.kind !== "workflow_param" ||
      typeof when.ref.node_id !== "string" ||
      when.ref.node_id.trim().length === 0 ||
      typeof when.ref.param !== "string" ||
      when.ref.param.trim().length === 0 ||
      typeof when.operator !== "string" ||
      !DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OVERRIDE_OPERATORS.has(when.operator)
    ) {
      continue;
    }

    const currentValue = resolveWorkflowParamValue(
      when.ref.node_id.trim(),
      when.ref.param.trim(),
      options,
    );
    if (!compareConditionValue(currentValue, when.operator, when.value)) {
      continue;
    }

    return parseDerivedMaskSourceVideoTreatment(override.value);
  }

  return defaultTreatment;
}

export function resolveDerivedMaskVideoTreatmentForNode(
  sourceNodeId: string,
  widgetInputs: readonly DerivedMaskVideoTreatmentWidgetLike[],
  widgetValues: Record<string, Record<string, unknown>>,
  defaultTreatment: DerivedMaskSourceVideoTreatment = DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT,
): DerivedMaskSourceVideoTreatment {
  const widget = widgetInputs.find(
    (candidate) =>
      candidate.nodeId === sourceNodeId &&
      isDerivedMaskSourceVideoTreatmentWidgetParam(candidate.param) &&
      candidate.config.frontendOnly === true,
  );

  if (!widget) {
    return defaultTreatment;
  }

  const currentValue =
    widgetValues[sourceNodeId]?.[
      DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM
    ] ??
    widgetValues[sourceNodeId]?.[
      LEGACY_DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM
    ] ??
    widget.currentValue;

  return parseDerivedMaskSourceVideoTreatment(currentValue);
}

export function resolveDerivedMaskVideoTreatments(
  derivedMaskMappings: readonly DerivedMaskSourceLike[],
  widgetInputs: readonly DerivedMaskVideoTreatmentWidgetLike[],
  widgetValues: Record<string, Record<string, unknown>>,
  defaultTreatment: DerivedMaskSourceVideoTreatment = DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT,
): Record<string, DerivedMaskSourceVideoTreatment> {
  const treatments: Record<string, DerivedMaskSourceVideoTreatment> = {};
  const sourceNodeIds = new Set(
    derivedMaskMappings.map((mapping) => mapping.sourceNodeId),
  );

  for (const sourceNodeId of sourceNodeIds) {
    treatments[sourceNodeId] = resolveDerivedMaskVideoTreatmentForNode(
      sourceNodeId,
      widgetInputs,
      widgetValues,
      defaultTreatment,
    );
  }

  return treatments;
}
