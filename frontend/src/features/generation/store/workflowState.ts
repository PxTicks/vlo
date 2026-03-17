import {
  DEFAULT_WORKFLOW_MASK_CROPPING,
  DEFAULT_WORKFLOW_POSTPROCESSING,
  resolvePresentedInputs,
  resolveWidgetInputs,
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
  return resolvePresentedInputs(
    inferredInputs,
    rules ?? EMPTY_WORKFLOW_RULES,
    workflow,
  );
}

export { resolveWidgetInputs };
