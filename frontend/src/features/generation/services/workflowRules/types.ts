import type {
  DerivedWorkflowWidgetInput,
  WorkflowInput,
  WorkflowManualSlotSelectionConfig,
  WorkflowMaskCroppingMode,
  WorkflowParamReference,
  WorkflowPostprocessingConfig,
  WorkflowRuleSlotInputType,
  WorkflowWidgetInput,
  WidgetInputConfig,
  WidgetValueType,
} from "../../types";
import type {
  DerivedMaskMapping,
  DerivedMaskType,
} from "../../pipeline/types";

export interface WorkflowRuleWarning {
  code: string;
  message: string;
  node_id?: string;
  output_index?: number;
  details?: Record<string, unknown>;
}

export interface WorkflowRuleNodePresent {
  enabled?: boolean;
  required?: boolean;
  input_type?: string;
  param?: string;
  label?: string;
  class_type?: string;
}

export interface WorkflowInputCondition {
  kind: "at_least_one";
  inputs: string[];
  message?: string;
}

export interface WorkflowRequiredInputValidationRule {
  kind: "required";
  input: string;
  message?: string;
}

export interface WorkflowAtLeastNInputValidationRule {
  kind: "at_least_n";
  inputs: string[];
  min: number;
  message?: string;
}

export interface WorkflowOptionalInputValidationRule {
  kind: "optional";
  input: string;
  message?: string;
}

export type WorkflowInputValidationRule =
  | WorkflowRequiredInputValidationRule
  | WorkflowAtLeastNInputValidationRule
  | WorkflowOptionalInputValidationRule;

export interface WorkflowValidationConfig {
  inputs: WorkflowInputValidationRule[];
}

export interface WorkflowInputValidationFailure {
  kind: WorkflowInputValidationRule["kind"];
  message: string;
  input?: string;
  inputs?: string[];
  min?: number;
  provided?: number;
}

export interface WorkflowRuleWidgetEntry {
  label?: string;
  control_after_generate?: boolean;
  default_randomize?: boolean;
  frontend_only?: boolean;
  hidden?: boolean;
  group_id?: string;
  group_title?: string;
  group_order?: number;
  min?: number;
  max?: number;
  default?: unknown;
  value_type?: WidgetValueType;
  options?: Array<string | number | boolean>;
}

export interface WorkflowRuleNode {
  ignore?: boolean;
  present?: WorkflowRuleNodePresent;
  widgets_mode?: "control_after_generate" | "all";
  widgets?: Record<string, WorkflowRuleWidgetEntry>;
  node_title?: string;
  selection?: WorkflowRuleSelectionConfig;
  binary_derived_mask_of?: string;
  soft_derived_mask_of?: string;
}

export interface WorkflowRuleSelectionConfig {
  export_fps?: number;
  frame_step?: number;
  max_frames?: number;
}

export interface WorkflowRuleSlot {
  input_type?: string;
  label?: string;
  param?: string;
  experimental?: boolean;
  export_fps?: number;
  frame_step?: number;
  max_frames?: number;
}

export interface WorkflowMaskCroppingConfig {
  mode: WorkflowMaskCroppingMode;
}

export interface WorkflowDualSamplerDenoiseRule {
  id: string;
  kind: "dual_sampler_denoise";
  label?: string;
  group_id?: string;
  group_title?: string;
  group_order?: number;
  total_steps: WorkflowParamReference;
  start_step: WorkflowParamReference;
  base_split_step: WorkflowParamReference;
  split_step_targets: WorkflowParamReference[];
}

export type WorkflowDerivedWidgetRule = WorkflowDualSamplerDenoiseRule;

export const DEFAULT_WORKFLOW_POSTPROCESSING: WorkflowPostprocessingConfig = {
  mode: "auto",
  panel_preview: "raw_outputs",
  on_failure: "fallback_raw",
};

export const DEFAULT_WORKFLOW_MASK_CROPPING: WorkflowMaskCroppingConfig = {
  mode: "crop",
};

export const DEFAULT_GENERATION_TARGET_RESOLUTION = 1080;
export const DEFAULT_GENERATION_RESOLUTION_OPTIONS = [
  360,
  480,
  720,
  1080,
] as const;

export interface WorkflowAspectRatioProcessingConfig {
  enabled: boolean;
  stride: number;
  search_steps: number;
  resolutions: number[];
  target_nodes: Array<{
    node_id: string;
    width_param: string;
    height_param: string;
  }>;
  postprocess: {
    enabled: boolean;
    mode: string;
    apply_to: string;
  };
}

export interface WorkflowRules {
  version: number;
  nodes: Record<string, WorkflowRuleNode>;
  validation?: WorkflowValidationConfig;
  input_conditions?: WorkflowInputCondition[];
  derived_widgets?: WorkflowDerivedWidgetRule[];
  output_injections: Record<
    string,
    Record<
      string,
      {
        source?: {
          kind?: string;
          node_id?: string;
          output_index?: number;
          slot_id?: string;
        };
      }
    >
  >;
  slots: Record<string, WorkflowRuleSlot>;
  mask_cropping: WorkflowMaskCroppingConfig;
  postprocessing: WorkflowPostprocessingConfig;
  aspect_ratio_processing?: WorkflowAspectRatioProcessingConfig;
}

export interface WorkflowRulesResponse {
  workflow_id: string;
  rules: WorkflowRules;
  warnings: WorkflowRuleWarning[];
}

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
  WorkflowManualSlotSelectionConfig,
  WorkflowRuleSlotInputType,
  WorkflowWidgetInput,
  WidgetInputConfig,
};
