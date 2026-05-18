import type { WorkflowWidgetInput } from "../types";

export type WidgetValueMap = Record<string, Record<string, unknown>>;
export type WidgetCurrentValueMap = Record<string, unknown>;

export interface WidgetValueReconciliationOptions {
  widgetInputs: readonly WorkflowWidgetInput[];
  previousValues: WidgetValueMap;
  previousCurrentValues: WidgetCurrentValueMap;
}

export interface WidgetValueReconciliationResult {
  values: WidgetValueMap;
  currentValues: WidgetCurrentValueMap;
  valuesChanged: boolean;
  currentValuesChanged: boolean;
}

function buildWidgetValueKey(nodeId: string, param: string): string {
  return `${nodeId}:${param}`;
}

function hasOwnKey(
  record: object | null | undefined,
  key: PropertyKey,
): boolean {
  if (record == null) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function reconcileWidgetValues({
  widgetInputs,
  previousValues,
  previousCurrentValues,
}: WidgetValueReconciliationOptions): WidgetValueReconciliationResult {
  const presentByNode = new Map<string, Set<string>>();
  const presentKeys = new Set<string>();

  let nextValues = previousValues;
  let valuesChanged = false;
  const setNextValue = (nodeId: string, param: string, value: unknown) => {
    if (!valuesChanged) {
      nextValues = { ...previousValues };
      valuesChanged = true;
    }
    nextValues[nodeId] = {
      ...(nextValues[nodeId] ?? {}),
      [param]: value,
    };
  };

  let nextCurrentValues = previousCurrentValues;
  let currentValuesChanged = false;
  const setNextCurrentValue = (key: string, value: unknown) => {
    if (!currentValuesChanged) {
      nextCurrentValues = { ...previousCurrentValues };
      currentValuesChanged = true;
    }
    nextCurrentValues[key] = value;
  };

  for (const widget of widgetInputs) {
    let params = presentByNode.get(widget.nodeId);
    if (!params) {
      params = new Set();
      presentByNode.set(widget.nodeId, params);
    }
    params.add(widget.param);

    const key = buildWidgetValueKey(widget.nodeId, widget.param);
    presentKeys.add(key);

    const hadPreviousCurrentValue = hasOwnKey(previousCurrentValues, key);
    const previousCurrentValue = previousCurrentValues[key];
    const backingValueChanged =
      hadPreviousCurrentValue &&
      !Object.is(previousCurrentValue, widget.currentValue);
    if (!hadPreviousCurrentValue || backingValueChanged) {
      setNextCurrentValue(key, widget.currentValue);
    }

    const previousNodeValues = previousValues[widget.nodeId];
    const hasPreviousValue = hasOwnKey(previousNodeValues, widget.param);
    if (!hasPreviousValue || backingValueChanged) {
      setNextValue(widget.nodeId, widget.param, widget.currentValue);
    }
  }

  for (const [nodeId, params] of Object.entries(previousValues)) {
    const presentParams = presentByNode.get(nodeId);
    for (const param of Object.keys(params)) {
      if (presentParams?.has(param)) continue;
      if (!valuesChanged) {
        nextValues = { ...previousValues };
        valuesChanged = true;
      }
      const nodeCopy = { ...(nextValues[nodeId] ?? {}) };
      delete nodeCopy[param];
      if (Object.keys(nodeCopy).length === 0) {
        const tmp = { ...nextValues };
        delete tmp[nodeId];
        nextValues = tmp;
      } else {
        nextValues[nodeId] = nodeCopy;
      }
    }
  }

  for (const key of Object.keys(previousCurrentValues)) {
    if (presentKeys.has(key)) continue;
    if (!currentValuesChanged) {
      nextCurrentValues = { ...previousCurrentValues };
      currentValuesChanged = true;
    }
    delete nextCurrentValues[key];
  }

  return {
    values: nextValues,
    currentValues: nextCurrentValues,
    valuesChanged,
    currentValuesChanged,
  };
}
