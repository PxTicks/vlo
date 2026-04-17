/**
 * Evaluates rewrite rules from a workflow sidecar against UI state.
 *
 * This is a pure function: given a list of rewrite rules and the set of
 * provided input IDs, it accumulates bypass node IDs and widget overrides
 * to apply before calling graphToPrompt.
 */

import type { WorkflowRules } from "./workflowRules";

export interface RewriteCondition {
  kind: "input_missing" | "input_present";
  input: string;
}

export interface WidgetOverride {
  node_id: string;
  widget: string;
  value: unknown;
}

export interface RewriteRule {
  when: RewriteCondition;
  bypass?: string[];
  set_widgets?: WidgetOverride[];
}

export interface EvaluateRewritesResult {
  bypass: string[];
  widgetOverrides: WidgetOverride[];
}

interface InputPresenceCondition {
  kind?: "input_presence";
  inputs?: string[] | null;
  match?: "all_present" | "all_missing" | "any_present" | "any_missing" | null;
}

function evaluateCondition(
  condition: RewriteCondition,
  providedInputIds: ReadonlySet<string>,
): boolean {
  switch (condition.kind) {
    case "input_missing":
      return !providedInputIds.has(condition.input);
    case "input_present":
      return providedInputIds.has(condition.input);
    default:
      return false;
  }
}

function evaluateInputPresenceCondition(
  condition: InputPresenceCondition | null | undefined,
  providedInputIds: ReadonlySet<string>,
): boolean {
  if (!condition || condition.kind !== "input_presence") {
    return false;
  }

  const inputs = (condition.inputs ?? [])
    .map((inputId) => inputId.trim())
    .filter((inputId) => inputId.length > 0);
  if (inputs.length === 0) {
    return false;
  }

  switch (condition.match ?? "all_present") {
    case "all_present":
      return inputs.every((inputId) => providedInputIds.has(inputId));
    case "all_missing":
      return inputs.every((inputId) => !providedInputIds.has(inputId));
    case "any_present":
      return inputs.some((inputId) => providedInputIds.has(inputId));
    case "any_missing":
      return inputs.some((inputId) => !providedInputIds.has(inputId));
    default:
      return false;
  }
}

/**
 * Evaluate each rewrite rule against the current UI state and accumulate
 * the bypass list and widget overrides.
 */
export function evaluateRewrites(
  rewrites: RewriteRule[],
  providedInputIds: ReadonlySet<string>,
): EvaluateRewritesResult {
  const bypass: string[] = [];
  const widgetOverrides: WidgetOverride[] = [];

  for (const rule of rewrites) {
    if (!evaluateCondition(rule.when, providedInputIds)) {
      continue;
    }

    if (rule.bypass) {
      for (const nodeId of rule.bypass) {
        if (!bypass.includes(nodeId)) {
          bypass.push(nodeId);
        }
      }
    }

    if (rule.set_widgets) {
      widgetOverrides.push(...rule.set_widgets);
    }
  }

  return { bypass, widgetOverrides };
}

/**
 * Evaluate conditional widget defaults so the live LiteGraph graph can mirror
 * the backend's `default_overrides` behavior before graphToPrompt runs.
 */
export function evaluateWidgetDefaultOverrides(
  rules: WorkflowRules | null | undefined,
  providedInputIds: ReadonlySet<string>,
): WidgetOverride[] {
  const widgetOverrides: WidgetOverride[] = [];

  for (const [nodeId, nodeRule] of Object.entries(rules?.nodes ?? {})) {
    for (const [widget, widgetRule] of Object.entries(nodeRule.widgets ?? {})) {
      for (const override of widgetRule.default_overrides ?? []) {
        if (!evaluateInputPresenceCondition(override.when, providedInputIds)) {
          continue;
        }

        widgetOverrides.push({
          node_id: nodeId,
          widget,
          value: override.value,
        });
        break;
      }
    }
  }

  return widgetOverrides;
}
