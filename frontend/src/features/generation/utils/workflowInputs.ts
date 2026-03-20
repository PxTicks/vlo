import type { WorkflowInput } from "../types";

const WORKFLOW_INPUT_ID_SEPARATOR = ":";

export function buildWorkflowInputId(nodeId: string, param: string): string {
  return `${nodeId}${WORKFLOW_INPUT_ID_SEPARATOR}${param}`;
}

export function getWorkflowInputId(
  input: Pick<WorkflowInput, "id" | "nodeId" | "param">,
): string {
  return input.id ?? buildWorkflowInputId(input.nodeId, input.param);
}

export function buildNodeInputRequestKey(nodeId: string, param: string): string {
  return `${nodeId}_${param}`;
}

export function getNodeInputRequestKey(
  input: Pick<WorkflowInput, "nodeId" | "param">,
): string {
  return buildNodeInputRequestKey(input.nodeId, input.param);
}
