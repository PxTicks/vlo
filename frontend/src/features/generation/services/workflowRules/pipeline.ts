import type {
  ConditionExpression,
  PipelineControl,
  PipelineControlCondition,
  WorkflowAspectRatioStage,
  WorkflowMaskProcessingStage,
  WorkflowOutputAssemblyStage,
  WorkflowPostprocessingConfig,
  WorkflowRules,
} from "./types";
import type { WorkflowInputMetadataMap } from "../../pipeline/types";
import {
  coerceRuleBoolean,
  createFrontendRuleState,
  evaluateCondition,
  resolveStateReference,
} from "../frontendRuleState";

type WorkflowPipelineStage = NonNullable<WorkflowRules["pipeline"]>[number];

export interface WorkflowControlResolutionOptions {
  frontendStateWidgetValues?: Readonly<Record<string, unknown>>;
  inputMetadata?: Readonly<WorkflowInputMetadataMap>;
  providedInputIds?: ReadonlySet<string>;
}

export function findWorkflowStageByKind<TStage extends WorkflowPipelineStage>(
  rules: WorkflowRules | null | undefined,
  kind: string,
): TStage | null {
  for (const stage of rules?.pipeline ?? []) {
    if (stage.kind === kind) {
      return stage as TStage;
    }
  }
  return null;
}

export function findWorkflowStageById<TStage extends WorkflowPipelineStage>(
  rules: WorkflowRules | null | undefined,
  stageId: string,
): TStage | null {
  for (const stage of rules?.pipeline ?? []) {
    if (stage.id === stageId) {
      return stage as TStage;
    }
  }
  return null;
}

export function getWorkflowStageControl(
  stage: { controls?: PipelineControl[] } | null | undefined,
  key: string,
): PipelineControl | null {
  for (const control of stage?.controls ?? []) {
    if (control.key === key) {
      return control;
    }
  }
  return null;
}

export function getMaskProcessingStage(
  rules: WorkflowRules | null | undefined,
): WorkflowMaskProcessingStage | null {
  return findWorkflowStageByKind<WorkflowMaskProcessingStage>(
    rules,
    "mask_processing",
  );
}

export function getAspectRatioStage(
  rules: WorkflowRules | null | undefined,
): WorkflowAspectRatioStage | null {
  return findWorkflowStageByKind<WorkflowAspectRatioStage>(
    rules,
    "aspect_ratio",
  );
}

export function getOutputAssemblyStage(
  rules: WorkflowRules | null | undefined,
): WorkflowOutputAssemblyStage | null {
  return findWorkflowStageByKind<WorkflowOutputAssemblyStage>(
    rules,
    "output_assembly",
  );
}

export function getMaskCropModeDefault(
  rules: WorkflowRules | null | undefined,
  options: WorkflowControlResolutionOptions = {},
): "crop" | "full" {
  const control = getWorkflowStageControl(getMaskProcessingStage(rules), "crop_mode");
  return resolvePipelineControlDefaultValue(control, options) === "full"
    ? "full"
    : "crop";
}

export function getMaskCropDilationDefault(
  rules: WorkflowRules | null | undefined,
  fallbackOrOptions: number | WorkflowControlResolutionOptions = 0.1,
  maybeOptions: WorkflowControlResolutionOptions = {},
): number {
  const fallback =
    typeof fallbackOrOptions === "number" ? fallbackOrOptions : 0.1;
  const options =
    typeof fallbackOrOptions === "number" ? maybeOptions : fallbackOrOptions;
  const control = getWorkflowStageControl(
    getMaskProcessingStage(rules),
    "crop_dilation",
  );
  const resolvedValue = resolvePipelineControlDefaultValue(control, options);
  return typeof resolvedValue === "number" ? resolvedValue : fallback;
}

function normalizePipelineControlValue(
  control: PipelineControl,
  value: unknown,
): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  let normalizedValue: unknown = value;
  if (control.value_type === "boolean") {
    normalizedValue = coerceRuleBoolean(value);
  } else if (control.value_type === "int") {
    if (typeof value === "number" && Number.isInteger(value)) {
      normalizedValue = value;
    } else if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      normalizedValue = Number.isInteger(parsed) ? parsed : null;
    } else {
      normalizedValue = null;
    }
  } else if (control.value_type === "float") {
    if (typeof value === "number") {
      normalizedValue = Number.isFinite(value) ? value : null;
    } else if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      normalizedValue = Number.isFinite(parsed) ? parsed : null;
    } else {
      normalizedValue = null;
    }
  } else if (control.value_type === "string" && typeof value !== "string") {
    normalizedValue = null;
  }

  if (normalizedValue === null || normalizedValue === undefined) {
    return null;
  }

  if (
    Array.isArray(control.options) &&
    control.options.length > 0 &&
    !control.options.some((option) => Object.is(option, normalizedValue))
  ) {
    return null;
  }

  return normalizedValue;
}

function matchesPipelineControlCondition(
  condition: PipelineControlCondition,
  options: WorkflowControlResolutionOptions,
): boolean {
  const frontendState = createFrontendRuleState(
    options.providedInputIds ?? new Set<string>(),
    options.frontendStateWidgetValues ?? {},
    options.inputMetadata ?? {},
  );
  const compareCondition: ConditionExpression = {
    kind: "compare",
    ref: condition.ref,
    operator: condition.operator ?? "eq",
    value: condition.value,
  };

  return evaluateCondition(compareCondition, frontendState);
}

export function resolvePipelineControlDefaultValue(
  control: PipelineControl | null,
  options: WorkflowControlResolutionOptions,
): unknown {
  if (!control) {
    return undefined;
  }

  if (control.bind) {
    const frontendState = createFrontendRuleState(
      options.providedInputIds ?? new Set<string>(),
      options.frontendStateWidgetValues ?? {},
      options.inputMetadata ?? {},
    );
    const boundValue = normalizePipelineControlValue(
      control,
      resolveStateReference(control.bind, frontendState),
    );
    if (boundValue !== null && boundValue !== undefined) {
      return boundValue;
    }
  }

  for (const defaultRule of control.default_rules ?? []) {
    if (!matchesPipelineControlCondition(defaultRule.when, options)) {
      continue;
    }

    const ruleValue = normalizePipelineControlValue(control, defaultRule.value);
    if (ruleValue !== null && ruleValue !== undefined) {
      return ruleValue;
    }
  }

  if (Object.prototype.hasOwnProperty.call(control, "default")) {
    return normalizePipelineControlValue(control, control.default);
  }

  return undefined;
}

export function getWorkflowPostprocessingConfig(
  rules: WorkflowRules | null | undefined,
  options: WorkflowControlResolutionOptions = {},
): WorkflowPostprocessingConfig {
  const outputAssemblyStage = getOutputAssemblyStage(rules);
  const config = outputAssemblyStage?.config;
  const attachGenerationMaskControl = getWorkflowStageControl(
    outputAssemblyStage,
    "attach_generation_mask",
  );
  const resolvedAttachGenerationMask = resolvePipelineControlDefaultValue(
    attachGenerationMaskControl,
    options,
  );
  const shouldAttachGenerationMask =
    resolvedAttachGenerationMask === false
      ? false
      : config?.attach_generation_mask;

  return {
    mode: config?.mode ?? "auto",
    panel_preview: config?.panel_preview ?? "raw_outputs",
    on_failure: config?.on_failure ?? "fallback_raw",
    ...(typeof config?.stitch_fps === "number"
      ? { stitch_fps: config.stitch_fps }
      : {}),
    ...(shouldAttachGenerationMask === false
      ? { attach_generation_mask: false }
      : {}),
  };
}

export function buildWorkflowReplayPipelineInputs(
  rules: WorkflowRules | null | undefined,
  options: {
    targetResolution: number;
    maskCropMode: "crop" | "full";
    maskCropDilation: number;
  },
): Record<string, Record<string, unknown>> {
  const pipelineInputs: Record<string, Record<string, unknown>> = {};

  const aspectRatioStage = getAspectRatioStage(rules);
  if (aspectRatioStage && getWorkflowStageControl(aspectRatioStage, "target_resolution")) {
    pipelineInputs[aspectRatioStage.id] = {
      target_resolution: options.targetResolution,
    };
  }

  const maskProcessingStage = getMaskProcessingStage(rules);
  if (maskProcessingStage) {
    const stageInputs: Record<string, unknown> = {};
    if (getWorkflowStageControl(maskProcessingStage, "crop_mode")) {
      stageInputs.crop_mode = options.maskCropMode;
    }
    if (
      options.maskCropMode !== "full" &&
      getWorkflowStageControl(maskProcessingStage, "crop_dilation")
    ) {
      stageInputs.crop_dilation = options.maskCropDilation;
    }
    if (Object.keys(stageInputs).length > 0) {
      pipelineInputs[maskProcessingStage.id] = stageInputs;
    }
  }

  return pipelineInputs;
}

export function getWorkflowReplayPipelineValue(
  rules: WorkflowRules | null | undefined,
  pipelineInputs: Record<string, Record<string, unknown>> | null | undefined,
  options: {
    stageKind: "aspect_ratio" | "mask_processing" | "output_assembly";
    key: string;
  },
): unknown {
  if (!pipelineInputs) {
    return undefined;
  }

  const stage =
    options.stageKind === "aspect_ratio"
      ? getAspectRatioStage(rules)
      : options.stageKind === "mask_processing"
        ? getMaskProcessingStage(rules)
        : getOutputAssemblyStage(rules);
  if (!stage) {
    return undefined;
  }

  const stageInputs = pipelineInputs[stage.id];
  if (!stageInputs || typeof stageInputs !== "object") {
    return undefined;
  }

  return stageInputs[options.key];
}
