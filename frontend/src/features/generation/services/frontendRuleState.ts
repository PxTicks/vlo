import type {
  ConditionExpression,
  EffectSwitch,
  StateReference,
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
  value?: unknown;
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

export function buildFrontendStateDerivedWidgetKey(
  derivedWidgetId: string,
): string {
  return `derived_widget_${derivedWidgetId}`;
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

function coerceNumeric(value: unknown): number | null {
  if (typeof value === "boolean") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

export function resolveStateReference(
  ref: StateReference | null | undefined,
  state: FrontendRuleState,
): unknown {
  if (!ref || typeof ref !== "object") {
    return undefined;
  }

  const kind = (ref as { kind?: string }).kind;
  if (kind === "workflow_param") {
    const { node_id: nodeId, param } = ref as {
      node_id: string;
      param: string;
    };
    if (typeof nodeId !== "string" || typeof param !== "string") {
      return undefined;
    }
    const key = buildFrontendStateWidgetKey(nodeId, param);
    return Object.prototype.hasOwnProperty.call(state.widgetValues, key)
      ? state.widgetValues[key]
      : undefined;
  }

  if (kind === "frontend_control") {
    const { control_id: controlId } = ref as { control_id: string };
    if (typeof controlId !== "string") {
      return undefined;
    }
    const key = buildFrontendStateControlKey(controlId);
    return Object.prototype.hasOwnProperty.call(state.widgetValues, key)
      ? state.widgetValues[key]
      : undefined;
  }

  if (kind === "derived_widget") {
    const { derived_widget_id: derivedId } = ref as {
      derived_widget_id: string;
    };
    if (typeof derivedId !== "string") {
      return undefined;
    }
    const key = buildFrontendStateDerivedWidgetKey(derivedId);
    return Object.prototype.hasOwnProperty.call(state.widgetValues, key)
      ? state.widgetValues[key]
      : undefined;
  }

  // pipeline_control values are not known on the frontend — conditions
  // authored against them simply never match here.
  return undefined;
}

function compareValues(
  current: unknown,
  operator: string,
  expected: unknown,
): boolean {
  if (
    operator === "lt" ||
    operator === "lte" ||
    operator === "gt" ||
    operator === "gte"
  ) {
    const currentNumber = coerceNumeric(current);
    const expectedNumber = coerceNumeric(expected);
    if (currentNumber === null || expectedNumber === null) {
      return false;
    }
    if (operator === "lt") return currentNumber < expectedNumber;
    if (operator === "lte") return currentNumber <= expectedNumber;
    if (operator === "gt") return currentNumber > expectedNumber;
    return currentNumber >= expectedNumber;
  }

  let matches: boolean;
  const currentBoolean = coerceBoolean(current);
  const expectedBoolean = coerceBoolean(expected);
  if (currentBoolean !== null && expectedBoolean !== null) {
    matches = currentBoolean === expectedBoolean;
  } else {
    const currentNumber = coerceNumeric(current);
    const expectedNumber = coerceNumeric(expected);
    if (currentNumber !== null && expectedNumber !== null) {
      matches = Math.abs(currentNumber - expectedNumber) <= 1e-9;
    } else if (typeof current === "string" && typeof expected === "string") {
      matches = current.trim().toLowerCase() === expected.trim().toLowerCase();
    } else {
      matches = current === expected;
    }
  }

  if (operator === "neq") {
    return !matches;
  }
  return matches;
}

function evaluateInputPresence(
  condition: { inputs?: string[]; match?: string | null },
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

export function evaluateCondition(
  condition: ConditionExpression | null | undefined,
  state: FrontendRuleState,
): boolean {
  if (!condition || typeof condition !== "object") {
    return false;
  }

  const kind = (condition as { kind?: string }).kind;
  if (kind === "always") {
    const value = (condition as { value?: unknown }).value;
    return value === undefined ? true : Boolean(value);
  }
  if (kind === "input_presence") {
    return evaluateInputPresence(
      condition as { inputs?: string[]; match?: string | null },
      state,
    );
  }
  if (kind === "compare") {
    const compare = condition as {
      ref?: StateReference;
      operator?: string;
      value?: unknown;
    };
    const current = resolveStateReference(compare.ref, state);
    return compareValues(current, compare.operator ?? "eq", compare.value);
  }
  if (kind === "all_of") {
    const conditions =
      (condition as { conditions?: ConditionExpression[] }).conditions ?? [];
    return conditions.every((inner) => evaluateCondition(inner, state));
  }
  if (kind === "any_of") {
    const conditions =
      (condition as { conditions?: ConditionExpression[] }).conditions ?? [];
    return conditions.some((inner) => evaluateCondition(inner, state));
  }
  if (kind === "not") {
    const inner = (condition as { condition?: ConditionExpression }).condition;
    return !evaluateCondition(inner, state);
  }
  return false;
}

/** @deprecated use {@link evaluateCondition} */
export function evaluateFrontendStateCondition(
  condition: ConditionExpression | null | undefined,
  state: FrontendRuleState,
): boolean {
  return evaluateCondition(condition, state);
}

export function evaluateRewriteEffects(
  rewrites: ReadonlyArray<WorkflowRewriteRule>,
  state: FrontendRuleState,
): EvaluateFrontendRuleEffectsResult {
  const bypass: string[] = [];
  const widgetOverrides: WidgetOverride[] = [];

  for (const rule of rewrites) {
    if (!evaluateCondition(rule.when, state)) {
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

export function evaluateEffectSwitches(
  switches: ReadonlyArray<EffectSwitch>,
  state: FrontendRuleState,
): EvaluateFrontendRuleEffectsResult {
  const bypass: string[] = [];
  const widgetOverrides: WidgetOverride[] = [];

  for (const effectSwitch of switches) {
    for (const caseEntry of effectSwitch.cases ?? []) {
      if (!evaluateCondition(caseEntry.when, state)) {
        continue;
      }

      for (const nodeId of caseEntry.bypass ?? []) {
        if (!bypass.includes(nodeId)) {
          bypass.push(nodeId);
        }
      }

      if (caseEntry.set_widgets) {
        widgetOverrides.push(...caseEntry.set_widgets);
      }
      break;
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
        if (!evaluateCondition(override.when, state)) {
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
