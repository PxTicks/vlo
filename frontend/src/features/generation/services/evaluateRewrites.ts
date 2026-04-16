/**
 * Evaluates rewrite rules from a workflow sidecar against UI state.
 *
 * This is a pure function: given a list of rewrite rules and the set of
 * provided input IDs, it accumulates bypass node IDs and widget overrides
 * to apply before calling graphToPrompt.
 */

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
