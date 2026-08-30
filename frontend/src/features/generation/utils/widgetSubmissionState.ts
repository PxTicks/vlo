import {
  buildFrontendStateDerivedWidgetKey,
  buildFrontendStateValueKey,
} from "../services/frontendRuleState";
import type { WorkflowWidgetInput } from "../types";
import { partitionNodeBypassWidgetInputs } from "./nodeBypassWidgets";
import { parseStoredWidgetValue } from "./storedWidgetValues";
import type { WidgetValueMap } from "./widgetValueReconciliation";

/**
 * The widget half of a submission, derived from what the panel currently
 * shows. Submitting and saving the panel's state for the project read the
 * same values, so both go through this.
 */
export interface WidgetSubmissionState {
  /** Backend widget overrides, omitted for randomized and frontend-only widgets. */
  widgetOverrides: Record<string, string>;
  frontendStateWidgetValues: Record<string, unknown>;
  derivedWidgetInputs: Record<string, string>;
  widgetModes: Record<string, "fixed" | "randomize">;
  bypassNodeIds: string[];
  activateNodeIds: string[];
}

export interface CollectWidgetSubmissionStateOptions {
  widgetInputs: readonly WorkflowWidgetInput[];
  widgetValues: WidgetValueMap;
  randomizeToggles: Record<string, boolean>;
  bypassedWidgetTargets: ReadonlySet<string>;
}

export function collectWidgetSubmissionState(
  options: CollectWidgetSubmissionStateOptions,
): WidgetSubmissionState {
  const widgetOverrides: Record<string, string> = {};
  const frontendStateWidgetValues: Record<string, unknown> = {};
  const derivedWidgetInputs: Record<string, string> = {};
  const widgetModes: Record<string, "fixed" | "randomize"> = {};

  const partitioned = partitionNodeBypassWidgetInputs(
    options.widgetInputs,
    options.bypassedWidgetTargets,
  );

  for (const w of partitioned.activeWidgetInputs) {
    const value =
      options.widgetValues[w.nodeId]?.[w.param] ?? w.currentValue;

    if (w.kind === "derived") {
      if (value !== undefined && value !== null) {
        derivedWidgetInputs[`derived_widget_${w.derivedWidgetId}`] =
          String(value);
        frontendStateWidgetValues[
          buildFrontendStateDerivedWidgetKey(w.derivedWidgetId)
        ] =
          typeof value === "string" ? parseStoredWidgetValue(w, value) : value;
      }
      continue;
    }

    if (value !== undefined && value !== null) {
      const frontendStateKey = buildFrontendStateValueKey({
        nodeId: w.nodeId,
        widget: w.param,
        frontendControlId: w.frontendControlId,
      });
      frontendStateWidgetValues[frontendStateKey] =
        typeof value === "string" ? parseStoredWidgetValue(w, value) : value;
    }

    const key = `${w.nodeId}:${w.param}`;
    const isRandomized = options.randomizeToggles[key] ?? false;
    if (w.config.controlAfterGenerate) {
      widgetModes[`widget_mode_${w.nodeId}_${w.param}`] = isRandomized
        ? "randomize"
        : "fixed";
    }
    if (w.config.frontendOnly) {
      continue;
    }
    // Randomization is resolved by the backend, so no value is sent: the
    // precision of large integer domains (seeds) must not round-trip strings.
    if (isRandomized && w.config.controlAfterGenerate) {
      continue;
    }
    if (value !== undefined && value !== null) {
      let storedValue: unknown = value;
      if (w.config.valueType === "boolean") {
        if (value === true && w.config.trueValue !== undefined) {
          storedValue = w.config.trueValue;
        } else if (value === false && w.config.falseValue !== undefined) {
          storedValue = w.config.falseValue;
        }
      }
      widgetOverrides[`widget_${w.nodeId}_${w.param}`] = String(storedValue);
    }
  }

  return {
    widgetOverrides,
    frontendStateWidgetValues,
    derivedWidgetInputs,
    widgetModes,
    bypassNodeIds: [...partitioned.bypassNodeIds],
    activateNodeIds: [...partitioned.activateNodeIds],
  };
}
