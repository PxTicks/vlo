import type { WorkflowReplayPanelState } from "../store/types";
import type { WorkflowInput, WorkflowWidgetInput } from "../types";
import {
  buildFrontendStateDerivedWidgetKey,
  buildFrontendStateValueKey,
} from "../services/frontendRuleState";
import { getWorkflowInputId } from "./workflowInputs";
import { parseStoredWidgetValue } from "./storedWidgetValues";
import type { WidgetValueMap } from "./widgetValueReconciliation";
import { getNodeBypassWidgetKey } from "./nodeBypassWidgets";

interface HydrationResult<T> {
  value: T;
  changed: boolean;
}

function hasEntries(record: Record<string, unknown>): boolean {
  return Object.keys(record).length > 0;
}

function setWidgetValue(
  values: WidgetValueMap,
  nodeId: string,
  param: string,
  value: unknown,
): void {
  values[nodeId] = {
    ...(values[nodeId] ?? {}),
    [param]: value,
  };
}

export function shouldWaitForReplayPanelHydration(
  replayState: WorkflowReplayPanelState,
  workflowInputs: readonly WorkflowInput[],
  widgetInputs: readonly WorkflowWidgetInput[],
  isWorkflowLoading: boolean,
): boolean {
  if (!isWorkflowLoading) {
    return false;
  }

  const needsWorkflowInputs = hasEntries(replayState.textValues);
  const needsWidgetInputs =
    hasEntries(replayState.widgetValues) ||
    hasEntries(replayState.derivedWidgetValues) ||
    hasEntries(replayState.widgetModes) ||
    (replayState.bypassNodeIds?.length ?? 0) > 0 ||
    (replayState.activateNodeIds?.length ?? 0) > 0;

  return (
    (needsWorkflowInputs && workflowInputs.length === 0) ||
    (needsWidgetInputs && widgetInputs.length === 0)
  );
}

/**
 * Rebuild bypass choices from recorded effects, falling back to the shipped
 * mode for older metadata. Bypass wins for malformed metadata naming both.
 */
export function resolveReplayNodeBypassWidgetTargets(
  replayState: WorkflowReplayPanelState,
  widgetInputs: readonly WorkflowWidgetInput[],
): ReadonlySet<string> {
  const bypassedNodes = new Set(replayState.bypassNodeIds ?? []);
  const activatedNodes = new Set(replayState.activateNodeIds ?? []);
  return new Set(
    widgetInputs.flatMap((widget) => {
      if (!widget.config.nodeBypassOption) return [];
      const wasBypassed = bypassedNodes.has(widget.nodeId)
        ? true
        : !activatedNodes.has(widget.nodeId) &&
          widget.config.nodeShipsBypassed === true;
      return wasBypassed
        ? [getNodeBypassWidgetKey(widget.nodeId, widget.param)]
        : [];
    }),
  );
}

export function hydrateReplayTextValues(
  previousValues: Record<string, string>,
  replayState: WorkflowReplayPanelState,
  workflowInputs: readonly WorkflowInput[],
): HydrationResult<Record<string, string>> {
  let nextValues = previousValues;

  for (const input of workflowInputs) {
    if (input.inputType !== "text") {
      continue;
    }

    const inputId = getWorkflowInputId(input);
    if (!Object.prototype.hasOwnProperty.call(replayState.textValues, inputId)) {
      continue;
    }

    const replayedValue = replayState.textValues[inputId] ?? "";
    if (nextValues[inputId] === replayedValue) {
      continue;
    }

    if (nextValues === previousValues) {
      nextValues = { ...previousValues };
    }
    nextValues[inputId] = replayedValue;
  }

  return {
    value: nextValues,
    changed: nextValues !== previousValues,
  };
}

export function resolveReplayWidgetValues(
  replayState: WorkflowReplayPanelState,
  widgetInputs: readonly WorkflowWidgetInput[],
): WidgetValueMap | null {
  if (
    !hasEntries(replayState.widgetValues) &&
    !hasEntries(replayState.derivedWidgetValues)
  ) {
    return null;
  }

  if (widgetInputs.length === 0) {
    return null;
  }

  const nextWidgetValues: WidgetValueMap = {};
  for (const widget of widgetInputs) {
    let restoredValue = widget.currentValue;

    if (widget.kind === "derived") {
      const replayKey = buildFrontendStateDerivedWidgetKey(
        widget.derivedWidgetId,
      );
      const storedValue = replayState.derivedWidgetValues[replayKey];
      if (typeof storedValue === "string") {
        restoredValue = parseStoredWidgetValue(widget, storedValue);
      }
    } else {
      const replayKey = buildFrontendStateValueKey({
        nodeId: widget.nodeId,
        widget: widget.param,
        frontendControlId: widget.frontendControlId,
      });
      const storedValue = replayState.widgetValues[replayKey];
      if (typeof storedValue === "string") {
        restoredValue = parseStoredWidgetValue(widget, storedValue);
      }
    }

    setWidgetValue(nextWidgetValues, widget.nodeId, widget.param, restoredValue);
  }

  return nextWidgetValues;
}

export function hydrateReplayRandomizeToggles(
  previousToggles: Record<string, boolean>,
  replayState: WorkflowReplayPanelState,
  widgetInputs: readonly WorkflowWidgetInput[],
): HydrationResult<Record<string, boolean>> {
  let nextToggles = previousToggles;

  for (const widget of widgetInputs) {
    if (!widget.config.controlAfterGenerate) {
      continue;
    }

    const replayKey = `widget_mode_${widget.nodeId}_${widget.param}`;
    const restoredMode = replayState.widgetModes[replayKey];
    if (!restoredMode) {
      continue;
    }

    const nextValue = restoredMode === "randomize";
    const toggleKey = `${widget.nodeId}:${widget.param}`;
    if (nextToggles[toggleKey] === nextValue) {
      continue;
    }

    if (nextToggles === previousToggles) {
      nextToggles = { ...previousToggles };
    }
    nextToggles[toggleKey] = nextValue;
  }

  return {
    value: nextToggles,
    changed: nextToggles !== previousToggles,
  };
}

export function areWidgetValueMapsEqual(
  left: WidgetValueMap,
  right: WidgetValueMap,
): boolean {
  const leftNodeIds = Object.keys(left);
  const rightNodeIds = Object.keys(right);
  if (leftNodeIds.length !== rightNodeIds.length) {
    return false;
  }

  for (const nodeId of leftNodeIds) {
    const leftParams = left[nodeId] ?? {};
    const rightParams = right[nodeId] ?? {};
    const leftParamIds = Object.keys(leftParams);
    const rightParamIds = Object.keys(rightParams);
    if (leftParamIds.length !== rightParamIds.length) {
      return false;
    }

    for (const param of leftParamIds) {
      if (!Object.is(leftParams[param], rightParams[param])) {
        return false;
      }
    }
  }

  return true;
}
