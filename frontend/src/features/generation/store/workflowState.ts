import {
  createDefaultWorkflowRules,
  resolvePresentedInputsFromRules,
  resolveWidgetInputsFromRules,
  type WorkflowInputCondition,
  type WorkflowInputValidationRule,
  type WorkflowRules,
} from "../services/workflowRules";
import type { WorkflowInput } from "../types";
import { extractWorkflowNodeMap } from "../utils/workflowNodeSignature";

export const EMPTY_WORKFLOW_RULES: WorkflowRules = createDefaultWorkflowRules();

function parseReferencedNodeId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const [nodeId] = trimmed.split(":", 1);
  return nodeId?.trim() || null;
}

function collectReferencedRuleNodeIds(
  value: unknown,
  result: Set<string>,
  key = "",
): void {
  const normalizedKey = key.trim().toLowerCase();

  if (typeof value === "string") {
    if (normalizedKey.endsWith("node_id") || normalizedKey === "input") {
      const nodeId = parseReferencedNodeId(value);
      if (nodeId) {
        result.add(nodeId);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    if (normalizedKey === "inputs" || normalizedKey === "bypass") {
      for (const entry of value) {
        if (typeof entry !== "string") {
          continue;
        }
        const nodeId = parseReferencedNodeId(entry);
        if (nodeId) {
          result.add(nodeId);
        }
      }
      return;
    }

    for (const entry of value) {
      collectReferencedRuleNodeIds(entry, result, key);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  if (normalizedKey === "nodes" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const nodeId of Object.keys(value as Record<string, unknown>)) {
      result.add(nodeId);
    }
  }

  for (const [childKey, childValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    collectReferencedRuleNodeIds(childValue, result, childKey);
  }
}

function collectReferencedFrontendControlIds(
  value: unknown,
  result: Set<string>,
  key = "",
): void {
  const normalizedKey = key.trim().toLowerCase();

  if (typeof value === "string") {
    if (normalizedKey === "control_id" && value.trim()) {
      result.add(value.trim());
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectReferencedFrontendControlIds(entry, result, key);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [childKey, childValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    collectReferencedFrontendControlIds(childValue, result, childKey);
  }
}

function collectWorkflowNodeIds(
  workflows: ReadonlyArray<Record<string, unknown> | null | undefined>,
): Set<string> {
  const nodeIds = new Set<string>();

  for (const workflow of workflows) {
    for (const nodeId of extractWorkflowNodeMap(workflow).keys()) {
      nodeIds.add(nodeId);
    }
  }

  return nodeIds;
}

function collectWorkflowNodeEntries(
  workflows: ReadonlyArray<Record<string, unknown> | null | undefined>,
): Map<string, string> {
  const nodeEntries = new Map<string, string>();

  for (const workflow of workflows) {
    for (const [nodeId, classType] of extractWorkflowNodeMap(workflow)) {
      if (!nodeEntries.has(nodeId)) {
        nodeEntries.set(nodeId, classType);
      }
    }
  }

  return nodeEntries;
}

function isRuleFragmentApplicable(
  value: unknown,
  workflowNodeIds: ReadonlySet<string>,
): boolean {
  const referencedRuleNodeIds = new Set<string>();
  collectReferencedRuleNodeIds(value, referencedRuleNodeIds);
  if (referencedRuleNodeIds.size === 0) {
    return true;
  }

  for (const nodeId of referencedRuleNodeIds) {
    if (!workflowNodeIds.has(nodeId)) {
      return false;
    }
  }

  return true;
}

function pruneInputIdentifiers(
  inputIds: readonly string[] | null | undefined,
  workflowNodeIds: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const pruned: string[] = [];

  for (const inputId of inputIds ?? []) {
    if (typeof inputId !== "string") {
      continue;
    }
    const nodeId = parseReferencedNodeId(inputId);
    if (!nodeId || !workflowNodeIds.has(nodeId) || seen.has(inputId)) {
      continue;
    }
    seen.add(inputId);
    pruned.push(inputId);
  }

  return pruned;
}

function pruneValidationRule(
  rule: WorkflowInputValidationRule,
  workflowNodeIds: ReadonlySet<string>,
): WorkflowInputValidationRule | null {
  if (rule.kind === "required" || rule.kind === "optional") {
    const nodeId = parseReferencedNodeId(rule.input);
    return nodeId && workflowNodeIds.has(nodeId) ? rule : null;
  }

  const inputs = pruneInputIdentifiers(rule.inputs, workflowNodeIds);
  if (inputs.length === 0) {
    return null;
  }

  return {
    ...rule,
    inputs,
    min: Math.min(rule.min, inputs.length),
  };
}

function pruneInputCondition(
  condition: WorkflowInputCondition,
  workflowNodeIds: ReadonlySet<string>,
): WorkflowInputCondition | null {
  const inputs = pruneInputIdentifiers(condition.inputs, workflowNodeIds);
  if (inputs.length === 0) {
    return null;
  }

  return {
    ...condition,
    inputs,
  };
}

function pruneRuleWhenOverrides<T extends { when: unknown }>(
  overrides: readonly T[] | null | undefined,
  workflowNodeIds: ReadonlySet<string>,
): T[] | undefined {
  const filtered = (overrides ?? []).filter((override) =>
    isRuleFragmentApplicable(override.when, workflowNodeIds),
  );

  return filtered.length > 0 ? filtered : undefined;
}

function pruneNodeRule(
  nodeRule: NonNullable<WorkflowRules["nodes"]>[string],
  workflowNodeIds: ReadonlySet<string>,
): NonNullable<WorkflowRules["nodes"]>[string] {
  const widgets = Object.fromEntries(
    Object.entries(nodeRule.widgets ?? {}).map(([param, widgetRule]) => {
      const defaultOverrides = pruneRuleWhenOverrides(
        widgetRule.default_overrides,
        workflowNodeIds,
      );

      return [
        param,
        {
          ...widgetRule,
          ...(defaultOverrides ? { default_overrides: defaultOverrides } : {}),
        },
      ];
    }),
  );
  const ignoreOverrides = pruneRuleWhenOverrides(
    nodeRule.ignore_overrides,
    workflowNodeIds,
  );

  return {
    ...nodeRule,
    ...(ignoreOverrides ? { ignore_overrides: ignoreOverrides } : {}),
    ...(Object.keys(widgets).length > 0 ? { widgets } : {}),
  };
}

function pruneStage(
  stage: NonNullable<WorkflowRules["pipeline"]>[number],
  workflowNodeIds: ReadonlySet<string>,
): NonNullable<WorkflowRules["pipeline"]>[number] | null {
  if (stage.kind === "mask_processing") {
    const targets = Array.isArray(stage.targets)
      ? stage.targets.filter((target) =>
          isRuleFragmentApplicable(target, workflowNodeIds),
        )
      : [];

    if (targets.length === 0) {
      return null;
    }

    return {
      ...stage,
      targets,
    };
  }

  if (stage.kind === "aspect_ratio") {
    const targets = Array.isArray(stage.targets)
      ? stage.targets.filter((target) =>
          isRuleFragmentApplicable(target, workflowNodeIds),
        )
      : [];

    if (targets.length === 0) {
      return null;
    }

    return {
      ...stage,
      targets,
    };
  }

  if (stage.kind !== "output_assembly") {
    return stage;
  }

  return stage;
}

export function pruneWorkflowRulesForWorkflows(
  workflows: ReadonlyArray<Record<string, unknown> | null | undefined>,
  rules: WorkflowRules | null | undefined,
): WorkflowRules {
  if (!rules) {
    return EMPTY_WORKFLOW_RULES;
  }

  const workflowNodeIds = collectWorkflowNodeIds(workflows);
  if (workflowNodeIds.size === 0) {
    return createDefaultWorkflowRules({
      name: rules.name ?? undefined,
      default_widgets_mode: rules.default_widgets_mode ?? undefined,
      slots: rules.slots ?? {},
    });
  }

  const nodes = Object.fromEntries(
    Object.entries(rules.nodes ?? {})
      .filter(([nodeId]) => workflowNodeIds.has(nodeId))
      .map(([nodeId, nodeRule]) => [
        nodeId,
        pruneNodeRule(nodeRule, workflowNodeIds),
      ]),
  );
  const validationInputs = (rules.validation?.inputs ?? [])
    .map((rule) => pruneValidationRule(rule, workflowNodeIds))
    .filter(
      (rule): rule is WorkflowInputValidationRule => rule !== null,
    );
  const inputConditions = (rules.input_conditions ?? [])
    .map((condition) => pruneInputCondition(condition, workflowNodeIds))
    .filter(
      (condition): condition is WorkflowInputCondition => condition !== null,
    );
  const derivedWidgets = (rules.derived_widgets ?? []).flatMap((rule) => {
    if (!isRuleFragmentApplicable(rule, workflowNodeIds)) {
      return [];
    }

    if (rule.kind === "dual_sampler_denoise") {
      const splitStepTargets = Array.isArray(rule.split_step_targets)
        ? rule.split_step_targets.filter((target) =>
            isRuleFragmentApplicable(target, workflowNodeIds),
          )
        : undefined;

      return [
        {
          ...rule,
          ...(splitStepTargets ? { split_step_targets: splitStepTargets } : {}),
        },
      ];
    }

    return [rule];
  });
  const rewrites = (rules.rewrites ?? []).filter((rewrite) =>
    isRuleFragmentApplicable(rewrite, workflowNodeIds),
  );
  const mediaFallbacks = (rules.media_fallbacks ?? []).filter((fallback) => {
    if (!workflowNodeIds.has(fallback.node_id)) {
      return false;
    }
    return fallback.when == null
      ? true
      : isRuleFragmentApplicable(fallback.when, workflowNodeIds);
  });
  const pipeline = (rules.pipeline ?? [])
    .map((stage) => pruneStage(stage, workflowNodeIds))
    .filter(
      (
        stage,
      ): stage is NonNullable<WorkflowRules["pipeline"]>[number] => stage !== null,
    );

  const referencedFrontendControlIds = new Set<string>();
  collectReferencedFrontendControlIds(
    {
      nodes,
      derived_widgets: derivedWidgets,
      rewrites,
      pipeline,
    },
    referencedFrontendControlIds,
  );
  const frontendControls = Object.fromEntries(
    Object.entries(rules.frontend_controls ?? {})
      .filter(([controlId]) => referencedFrontendControlIds.has(controlId))
      .map(([controlId, controlRule]) => {
        const defaultOverrides = pruneRuleWhenOverrides(
          controlRule.default_overrides,
          workflowNodeIds,
        );

        return [
          controlId,
          {
            ...controlRule,
            ...(defaultOverrides ? { default_overrides: defaultOverrides } : {}),
          },
        ];
      }),
  );

  return createDefaultWorkflowRules({
    name: rules.name ?? undefined,
    default_widgets_mode: rules.default_widgets_mode ?? undefined,
    nodes,
    validation: { inputs: validationInputs },
    ...(inputConditions.length > 0 ? { input_conditions: inputConditions } : {}),
    frontend_controls: frontendControls,
    derived_widgets: derivedWidgets,
    rewrites,
    slots: rules.slots ?? {},
    pipeline,
    ...(mediaFallbacks.length > 0 ? { media_fallbacks: mediaFallbacks } : {}),
  });
}

export function hasNodeLinkedWorkflowRules(
  rules: WorkflowRules | null | undefined,
): boolean {
  return (
    Object.keys(rules?.nodes ?? {}).length > 0 ||
    (rules?.validation?.inputs?.length ?? 0) > 0 ||
    (rules?.input_conditions?.length ?? 0) > 0 ||
    (rules?.derived_widgets?.length ?? 0) > 0 ||
    (rules?.rewrites?.length ?? 0) > 0 ||
    (rules?.media_fallbacks?.length ?? 0) > 0 ||
    (rules?.pipeline ?? []).some((stage) => stage.kind !== "output_assembly")
  );
}

export function areWorkflowRulesEffectivelyEmpty(
  rules: WorkflowRules | null | undefined,
): boolean {
  return (
    Object.keys(rules?.nodes ?? {}).length === 0 &&
    (rules?.validation?.inputs?.length ?? 0) === 0 &&
    (rules?.input_conditions?.length ?? 0) === 0 &&
    Object.keys(rules?.frontend_controls ?? {}).length === 0 &&
    (rules?.derived_widgets?.length ?? 0) === 0 &&
    (rules?.rewrites?.length ?? 0) === 0 &&
    (rules?.media_fallbacks?.length ?? 0) === 0 &&
    Object.keys(rules?.slots ?? {}).length === 0 &&
    (rules?.pipeline?.length ?? 0) === 0
  );
}

export function haveSubstantialWorkflowOverlap(
  leftWorkflows: ReadonlyArray<Record<string, unknown> | null | undefined>,
  rightWorkflows: ReadonlyArray<Record<string, unknown> | null | undefined>,
  minimumJaccard = 0.6,
): boolean {
  const leftNodes = collectWorkflowNodeEntries(leftWorkflows);
  const rightNodes = collectWorkflowNodeEntries(rightWorkflows);
  if (leftNodes.size === 0 || rightNodes.size === 0) {
    return false;
  }

  let overlap = 0;
  for (const [nodeId, classType] of leftNodes) {
    if (rightNodes.get(nodeId) === classType) {
      overlap += 1;
    }
  }

  const unionSize = leftNodes.size + rightNodes.size - overlap;
  return unionSize > 0 && overlap / unionSize >= minimumJaccard;
}

export function areWorkflowRulesCompatibleWithWorkflow(
  workflow: Record<string, unknown> | null | undefined,
  rules: WorkflowRules | null | undefined,
): boolean {
  const prunedRules = pruneWorkflowRulesForWorkflows([workflow], rules);
  if (areWorkflowRulesEffectivelyEmpty(prunedRules)) {
    return !rules || areWorkflowRulesEffectivelyEmpty(rules);
  }

  return true;
}

export function hasApplicableWorkflowRules(
  workflows: ReadonlyArray<Record<string, unknown> | null | undefined>,
  rules: WorkflowRules | null | undefined,
): boolean {
  return !areWorkflowRulesEffectivelyEmpty(
    pruneWorkflowRulesForWorkflows(workflows, rules),
  );
}

export function applyPresentationRules(
  inferredInputs: WorkflowInput[],
  rules: WorkflowRules | null,
  workflow?: Record<string, unknown> | null,
) {
  return resolvePresentedInputsFromRules(
    inferredInputs,
    rules ?? EMPTY_WORKFLOW_RULES,
    workflow,
  );
}

export function resolveWidgetInputs(
  workflow: Record<string, unknown> | null,
  rules: WorkflowRules | null,
  options: {
    graphData?: Record<string, unknown> | null;
    objectInfo?: Record<string, unknown> | null;
  } = {},
) {
  return resolveWidgetInputsFromRules(
    workflow,
    rules ?? EMPTY_WORKFLOW_RULES,
    options,
  );
}
