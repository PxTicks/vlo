import type {
  DerivedWorkflowWidgetInput,
  WorkflowInput,
  WorkflowSelectionConfig,
  WorkflowWidgetInput,
  WidgetInputConfig,
} from "../../types";
import type {
  DerivedMaskMapping,
  DerivedMaskType,
} from "../../pipeline/types";
import type {
  WorkflowAtLeastNInputValidationRule,
  WorkflowFrontendControl,
  WorkflowRewriteRule,
  WorkflowDualSamplerDenoiseRule,
  WorkflowRuleBooleanFrontendControlCondition,
  WorkflowRuleBooleanWidgetCondition,
  WorkflowRuleWidgetDefaultOverride,
  WorkflowOutputAssemblyStageConfig,
  WorkflowOptionalInputValidationRule,
  WorkflowRequiredInputValidationRule,
  WorkflowRuleWidgetInputPresenceCondition,
  WorkflowRules as GeneratedWorkflowRules,
  WorkflowVideoAudioRetakeRule,
} from "./generated";

export type {
  AspectRatioTargetNode,
  MaskProcessingTarget,
  PipelineControl,
  PipelineControlCondition,
  PipelineControlDefaultRule,
  PipelineControlReference,
  WorkflowAspectRatioPostprocessConfig,
  WorkflowAspectRatioStage,
  WorkflowAspectRatioStageConfig,
  WorkflowDualSamplerDenoiseRule,
  WorkflowFrontendControl,
  WorkflowInputCondition,
  WorkflowMaskProcessingStage,
  WorkflowOptionalInputValidationRule,
  WorkflowOutputAssemblyStage,
  WorkflowOutputAssemblyStageConfig,
  WorkflowParamReference,
  WorkflowParamValueReference,
  WorkflowRequiredInputValidationRule,
  WorkflowRewriteRule,
  WorkflowRuleBooleanFrontendControlCondition,
  WorkflowRuleNode,
  WorkflowRuleBooleanWidgetCondition,
  WorkflowRuleNodePresent,
  WorkflowRuleSelectionConfig,
  WorkflowRuleSlot,
  WorkflowRuleWidgetDefaultOverride,
  WorkflowRuleWidgetEntry,
  WorkflowRuleWidgetInputPresenceCondition,
  WorkflowValidationConfig,
  WorkflowVideoAudioRetakeRule,
} from "./generated";

export type WorkflowPostprocessingConfig = WorkflowOutputAssemblyStageConfig;

export type WorkflowInputValidationRule =
  | WorkflowRequiredInputValidationRule
  | WorkflowAtLeastNInputValidationRule
  | WorkflowOptionalInputValidationRule;

export type WorkflowDerivedWidgetRule =
  | WorkflowDualSamplerDenoiseRule
  | WorkflowVideoAudioRetakeRule;

export type WorkflowFrontendStateCondition =
  | WorkflowRuleWidgetInputPresenceCondition
  | WorkflowRuleBooleanWidgetCondition
  | WorkflowRuleBooleanFrontendControlCondition;

export interface WorkflowMediaFallback {
  kind: string;
  node_id: string;
  input_type: string;
  param?: string | null;
  when?: WorkflowRuleWidgetInputPresenceCondition | null;
  content_type?: string | null;
  filename?: string | null;
  synthetic?: boolean | null;
}

export type WorkflowRules = GeneratedWorkflowRules & {
  media_fallbacks?: WorkflowMediaFallback[];
};

export interface WorkflowRuleWarning {
  code: string;
  message: string;
  node_id?: string;
  output_index?: number;
  details?: Record<string, unknown>;
}

export interface WorkflowInputValidationFailure {
  kind: WorkflowInputValidationRule["kind"];
  message: string;
  input?: string;
  inputs?: string[];
  min?: number;
  provided?: number;
}

export interface WorkflowRulesResponse {
  workflow_id: string;
  has_sidecar?: boolean;
  rules: WorkflowRules;
  warnings: WorkflowRuleWarning[];
}

export const DEFAULT_WORKFLOW_POSTPROCESSING: WorkflowPostprocessingConfig = {
  mode: "auto",
  panel_preview: "raw_outputs",
  on_failure: "fallback_raw",
};

export function createDefaultWorkflowPostprocessing(): WorkflowPostprocessingConfig {
  return { ...DEFAULT_WORKFLOW_POSTPROCESSING };
}

function cloneJsonValue<T>(value: T): T {
  return structuredClone(value);
}

export function createDefaultWorkflowRules(
  overrides: Partial<WorkflowRules> = {},
): WorkflowRules {
  return {
    version: 3,
    ...(overrides.name !== undefined ? { name: overrides.name } : {}),
    ...(overrides.default_widgets_mode !== undefined
      ? { default_widgets_mode: overrides.default_widgets_mode }
      : {}),
    nodes: cloneJsonValue(overrides.nodes ?? {}),
    validation: cloneJsonValue(overrides.validation ?? { inputs: [] }),
    ...(overrides.input_conditions !== undefined
      ? { input_conditions: cloneJsonValue(overrides.input_conditions) }
      : {}),
    frontend_controls: cloneJsonValue(overrides.frontend_controls ?? {}),
    derived_widgets: cloneJsonValue(overrides.derived_widgets ?? []),
    output_injections: cloneJsonValue(overrides.output_injections ?? {}),
    rewrites: cloneJsonValue(overrides.rewrites ?? []),
    slots: cloneJsonValue(overrides.slots ?? {}),
    pipeline: cloneJsonValue(overrides.pipeline ?? []),
    ...(overrides.media_fallbacks !== undefined
      ? { media_fallbacks: cloneJsonValue(overrides.media_fallbacks) }
      : {}),
  };
}

export const DEFAULT_GENERATION_TARGET_RESOLUTION = 1080;
export const DEFAULT_GENERATION_RESOLUTION_OPTIONS = [
  360,
  480,
  720,
  1080,
] as const;

export interface ResolvePresentedInputsResult {
  inputs: WorkflowInput[];
  widgetInputs: WorkflowWidgetInput[];
  hasInferredInputs: boolean;
  presentationWarnings: WorkflowRuleWarning[];
  derivedMaskMappings: DerivedMaskMapping[];
}

export type {
  DerivedMaskMapping,
  DerivedMaskType,
  DerivedWorkflowWidgetInput,
  WorkflowInput,
  WorkflowSelectionConfig,
  WorkflowWidgetInput,
  WidgetInputConfig,
};
