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
  WorkflowAspectRatioProcessingConfig,
  WorkflowAtLeastNInputValidationRule,
  WorkflowDualSamplerDenoiseRule,
  WorkflowMaskCroppingConfig,
  WorkflowMaskProcessingConfig,
  WorkflowOptionalInputValidationRule,
  WorkflowPostprocessingConfig,
  WorkflowRequiredInputValidationRule,
  WorkflowRules,
} from "./generated";

export type {
  WorkflowAspectRatioProcessingConfig,
  WorkflowDualSamplerDenoiseRule,
  WorkflowInputCondition,
  WorkflowMaskCroppingConfig,
  WorkflowMaskProcessingConfig,
  WorkflowMaskSourceVideoTreatmentConfig,
  WorkflowOptionalInputValidationRule,
  WorkflowParamReference,
  WorkflowPostprocessingConfig,
  WorkflowRequiredInputValidationRule,
  WorkflowRuleNode,
  WorkflowRuleNodePresent,
  WorkflowRuleSelectionConfig,
  WorkflowRuleSlot,
  WorkflowRuleWidgetEntry,
  WorkflowRules,
  WorkflowValidationConfig,
} from "./generated";

export type WorkflowInputValidationRule =
  | WorkflowRequiredInputValidationRule
  | WorkflowAtLeastNInputValidationRule
  | WorkflowOptionalInputValidationRule;

export type WorkflowDerivedWidgetRule = WorkflowDualSamplerDenoiseRule;

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

export const DEFAULT_WORKFLOW_MASK_CROPPING: WorkflowMaskCroppingConfig = {
  mode: "crop",
};

export const DEFAULT_WORKFLOW_MASK_PROCESSING: WorkflowMaskProcessingConfig = {
  cropping: { ...DEFAULT_WORKFLOW_MASK_CROPPING },
  source_video_treatment: {
    default: "preserve_transparency",
    expose_as_widget: true,
    label: "Transparency handling",
  },
};

export const DEFAULT_WORKFLOW_ASPECT_RATIO_PROCESSING: WorkflowAspectRatioProcessingConfig =
  {
    enabled: true,
    stride: 16,
    search_steps: 2,
    resolutions: [],
    target_nodes: [],
    postprocess: {
      enabled: true,
      mode: "stretch_exact",
      apply_to: "all_visual_outputs",
    },
  };

export function createDefaultWorkflowPostprocessing(): WorkflowPostprocessingConfig {
  return { ...DEFAULT_WORKFLOW_POSTPROCESSING };
}

export function createDefaultWorkflowMaskCropping(): WorkflowMaskCroppingConfig {
  return { ...DEFAULT_WORKFLOW_MASK_CROPPING };
}

export function createDefaultWorkflowMaskProcessing(): WorkflowMaskProcessingConfig {
  return {
    cropping: { ...DEFAULT_WORKFLOW_MASK_PROCESSING.cropping },
    source_video_treatment: {
      ...DEFAULT_WORKFLOW_MASK_PROCESSING.source_video_treatment,
    },
  };
}

export function createDefaultWorkflowAspectRatioProcessing(): WorkflowAspectRatioProcessingConfig {
  return {
    ...DEFAULT_WORKFLOW_ASPECT_RATIO_PROCESSING,
    resolutions: [...(DEFAULT_WORKFLOW_ASPECT_RATIO_PROCESSING.resolutions ?? [])],
    target_nodes: [
      ...(DEFAULT_WORKFLOW_ASPECT_RATIO_PROCESSING.target_nodes ?? []),
    ],
    postprocess: {
      ...(DEFAULT_WORKFLOW_ASPECT_RATIO_PROCESSING.postprocess ?? {}),
    },
  };
}

export function createDefaultWorkflowRules(
  overrides: Partial<WorkflowRules> = {},
): WorkflowRules {
  const aspectRatioProcessing = overrides.aspect_ratio_processing;
  const maskProcessing = overrides.mask_processing;

  return {
    version: overrides.version ?? 1,
    ...(overrides.name !== undefined ? { name: overrides.name } : {}),
    nodes: overrides.nodes ?? {},
    validation: overrides.validation ?? { inputs: [] },
    ...(overrides.input_conditions !== undefined
      ? { input_conditions: overrides.input_conditions }
      : {}),
    derived_widgets: overrides.derived_widgets ?? [],
    output_injections: overrides.output_injections ?? {},
    slots: overrides.slots ?? {},
    mask_processing: maskProcessing
      ? {
          ...createDefaultWorkflowMaskProcessing(),
          ...maskProcessing,
          cropping: {
            ...createDefaultWorkflowMaskProcessing().cropping,
            ...(maskProcessing.cropping ?? {}),
          },
          source_video_treatment: {
            ...createDefaultWorkflowMaskProcessing().source_video_treatment,
            ...(maskProcessing.source_video_treatment ?? {}),
          },
        }
      : createDefaultWorkflowMaskProcessing(),
    postprocessing:
      overrides.postprocessing ?? createDefaultWorkflowPostprocessing(),
    aspect_ratio_processing: aspectRatioProcessing
      ? {
          ...createDefaultWorkflowAspectRatioProcessing(),
          ...aspectRatioProcessing,
          resolutions: [...(aspectRatioProcessing.resolutions ?? [])],
          target_nodes: [...(aspectRatioProcessing.target_nodes ?? [])],
          postprocess: {
            ...createDefaultWorkflowAspectRatioProcessing().postprocess,
            ...(aspectRatioProcessing.postprocess ?? {}),
          },
        }
      : createDefaultWorkflowAspectRatioProcessing(),
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
