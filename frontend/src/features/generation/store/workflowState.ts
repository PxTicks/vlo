import {
  DEFAULT_WORKFLOW_MASK_CROPPING,
  DEFAULT_WORKFLOW_POSTPROCESSING,
  resolvePresentedInputsFromRules,
  resolveWidgetInputsFromRules,
  type WorkflowRules,
} from "../services/workflowRules";
import type { WorkflowInput } from "../types";

export const EMPTY_WORKFLOW_RULES: WorkflowRules = {
  version: 1,
  nodes: {},
  output_injections: {},
  slots: {},
  mask_cropping: { ...DEFAULT_WORKFLOW_MASK_CROPPING },
  postprocessing: { ...DEFAULT_WORKFLOW_POSTPROCESSING },
};

export function applyPresentationRules(
  inferredInputs: WorkflowInput[],
  rules: WorkflowRules | null,
  workflow?: Record<string, unknown> | null,
) {
  return resolvePresentedInputsFromRules(
    inferredInputs,
    rules ?? EMPTY_WORKFLOW_RULES,
    workflow,
  );
}

export function resolveWidgetInputs(
  workflow: Record<string, unknown> | null,
  rules: WorkflowRules | null,
) {
  return resolveWidgetInputsFromRules(workflow, rules ?? EMPTY_WORKFLOW_RULES);
}
