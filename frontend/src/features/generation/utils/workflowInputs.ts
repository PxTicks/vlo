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

export function buildWorkflowInputLookup<
  T extends Pick<WorkflowInput, "id" | "nodeId" | "param">,
>(inputs: readonly T[]): Map<string, T> {
  const inputById = new Map<string, T>();
  const nodeIdCounts = new Map<string, number>();

  for (const input of inputs) {
    nodeIdCounts.set(input.nodeId, (nodeIdCounts.get(input.nodeId) ?? 0) + 1);
    inputById.set(getWorkflowInputId(input), input);
  }

  for (const input of inputs) {
    if ((nodeIdCounts.get(input.nodeId) ?? 0) === 1) {
      inputById.set(input.nodeId, input);
    }
  }

  return inputById;
}

export function getWorkflowInputValue<T>(
  values: Record<string, T>,
  input: Pick<WorkflowInput, "id" | "nodeId" | "param">,
  inputLookup?: ReadonlyMap<
    string,
    Pick<WorkflowInput, "id" | "nodeId" | "param">
  >,
): T | undefined {
  const inputId = getWorkflowInputId(input);
  if (Object.prototype.hasOwnProperty.call(values, inputId)) {
    return values[inputId];
  }

  if (
    inputId !== input.nodeId &&
    (!inputLookup || inputLookup.get(input.nodeId) === input) &&
    Object.prototype.hasOwnProperty.call(values, input.nodeId)
  ) {
    return values[input.nodeId];
  }

  return undefined;
}

export function resolveWorkflowInputKeys(
  inputId: string,
  inputLookup: ReadonlyMap<
    string,
    Pick<WorkflowInput, "id" | "nodeId" | "param">
  >,
): string[] {
  const input = inputLookup.get(inputId);
  if (!input) {
    return [inputId];
  }

  const canonicalInputId = getWorkflowInputId(input);
  if (
    canonicalInputId !== input.nodeId &&
    inputLookup.get(input.nodeId) === input
  ) {
    return [canonicalInputId, input.nodeId];
  }

  return [canonicalInputId];
}

export function buildNodeInputRequestKey(nodeId: string, param: string): string {
  return `${nodeId}_${param}`;
}

export function getNodeInputRequestKey(
  input: Pick<WorkflowInput, "nodeId" | "param">,
  inputLookup?: ReadonlyMap<
    string,
    Pick<WorkflowInput, "id" | "nodeId" | "param">
  >,
): string {
  if (!inputLookup || inputLookup.get(input.nodeId) === input) {
    return input.nodeId;
  }
  return buildNodeInputRequestKey(input.nodeId, input.param);
}
