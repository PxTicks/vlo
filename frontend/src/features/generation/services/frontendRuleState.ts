import type {
  WorkflowFrontendStateCondition,
  WorkflowRewriteRule,
  WorkflowRules,
} from "./workflowRules/types";

export interface FrontendRuleState {
  providedInputIds: ReadonlySet<string>;
  widgetValues: Readonly<Record<string, unknown>>;
}

export interface WidgetOverride {
  node_id: string;
  widget: string;
  value: unknown;
}

export interface EvaluateFrontendRuleEffectsResult {
  bypass: string[];
  widgetOverrides: WidgetOverride[];
}

export function buildFrontendStateWidgetKey(
  nodeId: string,
  widget: string,
): string {
  return `widget_${nodeId}_${widget}`;
}

export function buildFrontendStateControlKey(controlId: string): string {
  return `frontend_control_${controlId}`;
}

export function buildFrontendStateValueKey(options: {
  nodeId: string;
  widget: string;
  frontendControlId?: string | null;
}): string {
  if (options.frontendControlId) {
    return buildFrontendStateControlKey(options.frontendControlId);
  }
  return buildFrontendStateWidgetKey(options.nodeId, options.widget);
}

export function createFrontendRuleState(
  providedInputIds: ReadonlySet<string>,
  widgetValues: Readonly<Record<string, unknown>> = {},
): FrontendRuleState {
  return {
    providedInputIds,
    widgetValues,
  };
}

function evaluateInputPresenceCondition(
  condition: Extract<WorkflowFrontendStateCondition, { kind?: "input_presence" }>,
  state: FrontendRuleState,
): boolean {
  const inputs = (condition.inputs ?? [])
    .map((inputId) => inputId.trim())
    .filter((inputId) => inputId.length > 0);
  if (inputs.length === 0) {
    return false;
  }

  switch (condition.match ?? "all_present") {
    case "all_present":
      return inputs.every((inputId) => state.providedInputIds.has(inputId));
    case "all_missing":
      return inputs.every((inputId) => !state.providedInputIds.has(inputId));
    case "any_present":
      return inputs.some((inputId) => state.providedInputIds.has(inputId));
    case "any_missing":
      return inputs.some((inputId) => !state.providedInputIds.has(inputId));
    default:
      return false;
  }
}

function coerceBooleanFrontendWidgetValue(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

function evaluateBooleanWidgetCondition(
  condition: Extract<WorkflowFrontendStateCondition, { kind?: "widget_boolean" }>,
  state: FrontendRuleState,
): boolean {
  const key = buildFrontendStateWidgetKey(condition.node_id, condition.widget);
  if (!Object.prototype.hasOwnProperty.call(state.widgetValues, key)) {
    return false;
  }

  const actual = coerceBooleanFrontendWidgetValue(state.widgetValues[key]);
  if (actual === null) {
    return false;
  }

  return actual === (condition.value ?? true);
}

function evaluateBooleanFrontendControlCondition(
  condition: Extract<
    WorkflowFrontendStateCondition,
    { kind?: "frontend_control_boolean" }
  >,
  state: FrontendRuleState,
): boolean {
  const key = buildFrontendStateControlKey(condition.control_id);
  if (!Object.prototype.hasOwnProperty.call(state.widgetValues, key)) {
    return false;
  }

  const actual = coerceBooleanFrontendWidgetValue(state.widgetValues[key]);
  if (actual === null) {
    return false;
  }

  return actual === (condition.value ?? true);
}

export function evaluateFrontendStateCondition(
  condition: WorkflowFrontendStateCondition | null | undefined,
  state: FrontendRuleState,
): boolean {
  if (!condition?.kind) {
    return false;
  }

  switch (condition.kind) {
    case "input_presence":
      return evaluateInputPresenceCondition(condition, state);
    case "widget_boolean":
      return evaluateBooleanWidgetCondition(condition, state);
    case "frontend_control_boolean":
      return evaluateBooleanFrontendControlCondition(condition, state);
    default:
      return false;
  }
}

export function evaluateRewriteEffects(
  rewrites: ReadonlyArray<WorkflowRewriteRule>,
  state: FrontendRuleState,
): EvaluateFrontendRuleEffectsResult {
  const bypass: string[] = [];
  const widgetOverrides: WidgetOverride[] = [];

  for (const rule of rewrites) {
    if (!evaluateFrontendStateCondition(rule.when, state)) {
      continue;
    }

    for (const nodeId of rule.bypass ?? []) {
      if (!bypass.includes(nodeId)) {
        bypass.push(nodeId);
      }
    }

    if (rule.set_widgets) {
      widgetOverrides.push(...rule.set_widgets);
    }
  }

  return { bypass, widgetOverrides };
}

export function evaluateWidgetDefaultOverridesFromState(
  rules: WorkflowRules | null | undefined,
  state: FrontendRuleState,
): WidgetOverride[] {
  const widgetOverrides: WidgetOverride[] = [];

  for (const [nodeId, nodeRule] of Object.entries(rules?.nodes ?? {})) {
    for (const [widget, widgetRule] of Object.entries(nodeRule.widgets ?? {})) {
      for (const override of widgetRule.default_overrides ?? []) {
        if (!evaluateFrontendStateCondition(override.when, state)) {
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
