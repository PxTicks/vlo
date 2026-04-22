import type {
  EffectSwitch,
  WorkflowRewriteRule,
  WorkflowRules,
} from "./workflowRules/types";
import {
  createFrontendRuleState,
  evaluateEffectSwitches,
  evaluateRewriteEffects,
  evaluateWidgetDefaultOverridesFromState,
  type FrontendRuleState,
  type WidgetOverride,
} from "./frontendRuleState";

export type { FrontendRuleState, WidgetOverride };

export type RewriteRule = WorkflowRewriteRule;

export interface EvaluateRewritesResult {
  bypass: string[];
  widgetOverrides: WidgetOverride[];
}

export function evaluateRewrites(
  rewrites: RewriteRule[],
  providedInputIds: ReadonlySet<string>,
  widgetValues: Readonly<Record<string, unknown>> = {},
): EvaluateRewritesResult {
  return evaluateRewriteEffects(
    rewrites,
    createFrontendRuleState(providedInputIds, widgetValues),
  );
}

export function evaluateEffectSwitchesForState(
  switches: ReadonlyArray<EffectSwitch>,
  providedInputIds: ReadonlySet<string>,
  widgetValues: Readonly<Record<string, unknown>> = {},
): EvaluateRewritesResult {
  return evaluateEffectSwitches(
    switches,
    createFrontendRuleState(providedInputIds, widgetValues),
  );
}

export function evaluateWidgetDefaultOverrides(
  rules: WorkflowRules | null | undefined,
  providedInputIds: ReadonlySet<string>,
  widgetValues: Readonly<Record<string, unknown>> = {},
): WidgetOverride[] {
  return evaluateWidgetDefaultOverridesFromState(
    rules,
    createFrontendRuleState(providedInputIds, widgetValues),
  );
}
