import {
  createDefaultWorkflowRules,
  resolvePresentedInputsFromRules,
  resolveWidgetInputsFromRules,
  type WorkflowInputCondition,
  type WorkflowInputValidationRule,
  type WorkflowRules,
} from "../services/workflowRules";
import type { WorkflowInputMetadataMap } from "../pipeline/types";
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

  if (
    normalizedKey === "nodes" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
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

/**
 * Every top-level rules section this pruner rewrites. Anything else a rules
 * object carries — a section added to the backend schema after this code was
 * written, say — is passed through untouched rather than dropped: an
 * unpruned rule that still names a live node is recoverable, while a section
 * that quietly disappears is not (that is how `effect_switches` went missing
 * from replayed workflows). `workflowRules.pruneCoverage` test asserts this
 * list still covers the schema, so a new section is a failing test rather
 * than a silent pass-through.
 */
const PRUNED_RULE_SECTIONS = [
  "version",
  "name",
  "default_widgets_mode",
  "sections",
  "nodes",
  "validation",
  "input_conditions",
  "frontend_controls",
  "derived_widgets",
  "rewrites",
  "effect_switches",
  "slots",
  "pipeline",
  "media_fallbacks",
] as const satisfies readonly (keyof WorkflowRules)[];

export const PRUNED_WORKFLOW_RULE_SECTIONS: readonly string[] =
  PRUNED_RULE_SECTIONS;

function carryUnprunedSections(
  rules: WorkflowRules,
  pruned: WorkflowRules,
): WorkflowRules {
  const owned = new Set<string>(PRUNED_RULE_SECTIONS);
  const carried = Object.fromEntries(
    Object.entries(rules).filter(([section]) => !owned.has(section)),
  );
  return Object.keys(carried).length > 0
    ? ({ ...carried, ...pruned } as WorkflowRules)
    : pruned;
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
    // No workflow to check against: every node-linked section is inapplicable,
    // so only the workflow-independent ones survive.
    return carryUnprunedSections(
      rules,
      createDefaultWorkflowRules({
        name: rules.name ?? undefined,
        default_widgets_mode: rules.default_widgets_mode ?? undefined,
        ...(rules.sections !== undefined ? { sections: rules.sections } : {}),
        slots: rules.slots ?? {},
      }),
    );
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
    .filter((rule): rule is WorkflowInputValidationRule => rule !== null);
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
  // Cases are pruned individually, like rewrites: a case whose targets are all
  // gone cannot fire, but the switch's remaining cases still decide the mode.
  const effectSwitches = (rules.effect_switches ?? []).flatMap(
    (effectSwitch) => {
      const cases = (effectSwitch.cases ?? []).filter((effectCase) =>
        isRuleFragmentApplicable(effectCase, workflowNodeIds),
      );
      if (cases.length === 0) {
        return [];
      }
      return [{ ...effectSwitch, cases }];
    },
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
      (stage): stage is NonNullable<WorkflowRules["pipeline"]>[number] =>
        stage !== null,
    );

  const referencedFrontendControlIds = new Set<string>();
  collectReferencedFrontendControlIds(
    {
      nodes,
      derived_widgets: derivedWidgets,
      rewrites,
      effect_switches: effectSwitches,
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
            ...(defaultOverrides
              ? { default_overrides: defaultOverrides }
              : {}),
          },
        ];
      }),
  );

  return carryUnprunedSections(
    rules,
    createDefaultWorkflowRules({
      name: rules.name ?? undefined,
      default_widgets_mode: rules.default_widgets_mode ?? undefined,
      // Section titles/order/open state are panel presentation, not node
      // references: nothing here can make them inapplicable.
      ...(rules.sections !== undefined ? { sections: rules.sections } : {}),
      nodes,
      validation: { inputs: validationInputs },
      ...(inputConditions.length > 0
        ? { input_conditions: inputConditions }
        : {}),
      frontend_controls: frontendControls,
      derived_widgets: derivedWidgets,
      rewrites,
      effect_switches: effectSwitches,
      slots: rules.slots ?? {},
      pipeline,
      ...(mediaFallbacks.length > 0 ? { media_fallbacks: mediaFallbacks } : {}),
    }),
  );
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
    (rules?.effect_switches?.length ?? 0) > 0 ||
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
    (rules?.effect_switches?.length ?? 0) === 0 &&
    (rules?.media_fallbacks?.length ?? 0) === 0 &&
    Object.keys(rules?.slots ?? {}).length === 0 &&
    (rules?.pipeline?.length ?? 0) === 0
  );
}

export interface LostRuleFragments {
  pipelineStageIds: string[];
  nodeIds: string[];
  derivedWidgetIds: string[];
  effectSwitchIds: string[];
  effectSwitchCaseCount: number;
  rewriteCount: number;
  mediaFallbackCount: number;
  hasLoss: boolean;
}

export function findLostRuleFragments(
  previousRules: WorkflowRules | null | undefined,
  nextRules: WorkflowRules | null | undefined,
): LostRuleFragments {
  const prevPipelineIds = new Set(
    (previousRules?.pipeline ?? []).map((stage) => stage.id),
  );
  const nextPipelineIds = new Set(
    (nextRules?.pipeline ?? []).map((stage) => stage.id),
  );
  const pipelineStageIds = [...prevPipelineIds].filter(
    (id) => !nextPipelineIds.has(id),
  );

  const prevNodeIds = new Set(Object.keys(previousRules?.nodes ?? {}));
  const nextNodeIds = new Set(Object.keys(nextRules?.nodes ?? {}));
  const nodeIds = [...prevNodeIds].filter((id) => !nextNodeIds.has(id));

  const prevDerivedIds = new Set(
    (previousRules?.derived_widgets ?? []).map((widget) => widget.id),
  );
  const nextDerivedIds = new Set(
    (nextRules?.derived_widgets ?? []).map((widget) => widget.id),
  );
  const derivedWidgetIds = [...prevDerivedIds].filter(
    (id) => !nextDerivedIds.has(id),
  );

  const rewriteCount = Math.max(
    0,
    (previousRules?.rewrites?.length ?? 0) - (nextRules?.rewrites?.length ?? 0),
  );
  const countEffectSwitchCases = (
    rules: WorkflowRules | null | undefined,
  ): Map<string, number> =>
    new Map(
      (rules?.effect_switches ?? []).map((effectSwitch, index) => [
        effectSwitch.id ?? `#${index}`,
        (effectSwitch.cases ?? []).length,
      ]),
    );
  const prevEffectSwitchCases = countEffectSwitchCases(previousRules);
  const nextEffectSwitchCases = countEffectSwitchCases(nextRules);
  const effectSwitchIds = [...prevEffectSwitchCases.keys()].filter(
    (id) => !nextEffectSwitchCases.has(id),
  );
  // A switch is first-match-wins, so losing one case silently changes which
  // branch fires — the same failure a missing switch causes, minus the
  // missing switch. Count that as loss too.
  let effectSwitchCaseCount = 0;
  for (const [id, prevCases] of prevEffectSwitchCases) {
    const nextCases = nextEffectSwitchCases.get(id);
    if (nextCases === undefined) {
      continue;
    }
    effectSwitchCaseCount += Math.max(0, prevCases - nextCases);
  }
  const mediaFallbackCount = Math.max(
    0,
    (previousRules?.media_fallbacks?.length ?? 0) -
      (nextRules?.media_fallbacks?.length ?? 0),
  );

  return {
    pipelineStageIds,
    nodeIds,
    derivedWidgetIds,
    effectSwitchIds,
    effectSwitchCaseCount,
    rewriteCount,
    mediaFallbackCount,
    hasLoss:
      pipelineStageIds.length > 0 ||
      nodeIds.length > 0 ||
      derivedWidgetIds.length > 0 ||
      effectSwitchIds.length > 0 ||
      effectSwitchCaseCount > 0 ||
      rewriteCount > 0 ||
      mediaFallbackCount > 0,
  };
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
  graphData?: Record<string, unknown> | null,
) {
  return resolvePresentedInputsFromRules(
    inferredInputs,
    rules ?? EMPTY_WORKFLOW_RULES,
    workflow,
    [],
    graphData,
  );
}

export function resolveWidgetInputs(
  workflow: Record<string, unknown> | null,
  rules: WorkflowRules | null,
  options: {
    graphData?: Record<string, unknown> | null;
    objectInfo?: Record<string, unknown> | null;
    editorRef?: HTMLIFrameElement | null;
    providedInputIds?: ReadonlySet<string>;
    frontendStateWidgetValues?: Readonly<Record<string, unknown>>;
    inputMetadata?: Readonly<WorkflowInputMetadataMap>;
  } = {},
) {
  return resolveWidgetInputsFromRules(
    workflow,
    rules ?? EMPTY_WORKFLOW_RULES,
    options,
  );
}
