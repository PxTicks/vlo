import type { WorkflowInput } from "../types";

const WORKFLOW_INPUT_ID_SEPARATOR = ":";
const REPEATABLE_INPUT_SLOT_SEPARATOR = "::repeat::";
const REPEATABLE_REQUEST_KEY_SEPARATOR = "__repeat_";

export function buildWorkflowInputId(nodeId: string, param: string): string {
  return `${nodeId}${WORKFLOW_INPUT_ID_SEPARATOR}${param}`;
}

export function getWorkflowInputId(
  input: Pick<WorkflowInput, "id" | "nodeId" | "param">,
): string {
  return input.id ?? buildWorkflowInputId(input.nodeId, input.param);
}

export function buildRepeatableInputSlotId(
  input: Pick<WorkflowInput, "id" | "nodeId" | "param">,
  index: number,
): string {
  const inputId = getWorkflowInputId(input);
  return index <= 0
    ? inputId
    : `${inputId}${REPEATABLE_INPUT_SLOT_SEPARATOR}${Math.floor(index)}`;
}

export function parseRepeatableInputSlotId(
  inputId: string,
): { inputId: string; index: number } | null {
  const separatorIndex = inputId.lastIndexOf(REPEATABLE_INPUT_SLOT_SEPARATOR);
  if (separatorIndex <= 0) {
    return null;
  }
  const rawIndex = inputId.slice(
    separatorIndex + REPEATABLE_INPUT_SLOT_SEPARATOR.length,
  );
  if (!/^\d+$/.test(rawIndex)) {
    return null;
  }
  return {
    inputId: inputId.slice(0, separatorIndex),
    index: Number.parseInt(rawIndex, 10),
  };
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

export function resolveWorkflowInputForSlot<
  T extends Pick<WorkflowInput, "id" | "nodeId" | "param">,
>(inputId: string, inputLookup: ReadonlyMap<string, T>): T | undefined {
  const direct = inputLookup.get(inputId);
  if (direct) {
    return direct;
  }
  const repeatableSlot = parseRepeatableInputSlotId(inputId);
  return repeatableSlot ? inputLookup.get(repeatableSlot.inputId) : undefined;
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

export function getWorkflowInputSlotValue<T>(
  values: Record<string, T>,
  input: Pick<WorkflowInput, "id" | "nodeId" | "param">,
  index: number,
  inputLookup?: ReadonlyMap<
    string,
    Pick<WorkflowInput, "id" | "nodeId" | "param">
  >,
): T | undefined {
  if (index <= 0) {
    return getWorkflowInputValue(values, input, inputLookup);
  }
  return values[buildRepeatableInputSlotId(input, index)];
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

export function getNodeInputRequestKeyForSlot(
  inputId: string,
  input: Pick<WorkflowInput, "id" | "nodeId" | "param" | "presentation">,
  inputLookup?: ReadonlyMap<
    string,
    Pick<WorkflowInput, "id" | "nodeId" | "param">
  >,
): string {
  const requestKey = getNodeInputRequestKey(input, inputLookup);
  if (!input.presentation?.repeatable) {
    return requestKey;
  }
  const repeatableSlot = parseRepeatableInputSlotId(inputId);
  const index = repeatableSlot?.index ?? 0;
  return `${requestKey}${REPEATABLE_REQUEST_KEY_SEPARATOR}${index}`;
}

export function matchesNodeInputRequestKey(
  requestKey: string,
  input: Pick<WorkflowInput, "id" | "nodeId" | "param" | "presentation">,
  inputLookup?: ReadonlyMap<
    string,
    Pick<WorkflowInput, "id" | "nodeId" | "param">
  >,
): boolean {
  const baseRequestKey = getNodeInputRequestKey(input, inputLookup);
  return input.presentation?.repeatable
    ? requestKey.startsWith(
        `${baseRequestKey}${REPEATABLE_REQUEST_KEY_SEPARATOR}`,
      )
    : requestKey === baseRequestKey;
}
