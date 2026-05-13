import type { WorkflowInput } from "../../types";
import { getWorkflowInputId } from "../../utils/workflowInputs";
import { extractWorkflowNodeMap } from "../../utils/workflowNodeSignature";
import type {
  WorkflowInputCondition,
  WorkflowInputValidationFailure,
  WorkflowInputValidationRule,
  WorkflowRules,
} from "./types";

function parseNodeIdFromInputRef(inputRef: string | null | undefined): string | null {
  if (typeof inputRef !== "string") return null;
  const trimmed = inputRef.trim();
  if (!trimmed) return null;
  const [nodeId] = trimmed.split(":", 1);
  return nodeId?.trim() || null;
}

/**
 * Drop validation rules / input conditions whose target node IDs do not appear
 * in the submitted (post-bypass) workflow. Called at submission time so that
 * runtime bypass — either pre-baked `mode: 4` in the workflow file or manual-
 * mode auto-bypass of empty inputs — does not leave behind "required" rules
 * for nodes that graphToPrompt already pruned.
 */
export function pruneRulesForSubmittedWorkflow(
  rules: WorkflowRules | null | undefined,
  submittedWorkflow: Record<string, unknown> | null | undefined,
): WorkflowRules | null {
  if (!rules) return null;
  if (!submittedWorkflow) return rules;

  const surviving = new Set(extractWorkflowNodeMap(submittedWorkflow).keys());
  if (surviving.size === 0) return rules;

  const validationInputs = rules.validation?.inputs ?? [];
  const prunedValidationInputs: WorkflowInputValidationRule[] = [];
  let validationChanged = false;
  for (const rule of validationInputs) {
    if (rule.kind === "required" || rule.kind === "optional") {
      const nodeId = parseNodeIdFromInputRef(rule.input);
      if (nodeId && surviving.has(nodeId)) {
        prunedValidationInputs.push(rule);
      } else {
        validationChanged = true;
      }
      continue;
    }
    const ruleInputs = rule.inputs ?? [];
    const filtered = ruleInputs.filter((inputRef) => {
      const nodeId = parseNodeIdFromInputRef(inputRef);
      return nodeId !== null && surviving.has(nodeId);
    });
    if (filtered.length === 0) {
      validationChanged = true;
      continue;
    }
    if (filtered.length === ruleInputs.length) {
      prunedValidationInputs.push(rule);
      continue;
    }
    validationChanged = true;
    prunedValidationInputs.push({
      ...rule,
      inputs: filtered,
      min: Math.min(rule.min, filtered.length),
    });
  }

  const inputConditions = rules.input_conditions ?? [];
  const prunedInputConditions: WorkflowInputCondition[] = [];
  let conditionsChanged = false;
  for (const condition of inputConditions) {
    const filtered = (condition.inputs ?? []).filter((inputRef) => {
      const nodeId = parseNodeIdFromInputRef(inputRef);
      return nodeId !== null && surviving.has(nodeId);
    });
    if (filtered.length === 0) {
      conditionsChanged = true;
      continue;
    }
    if (filtered.length === (condition.inputs ?? []).length) {
      prunedInputConditions.push(condition);
      continue;
    }
    conditionsChanged = true;
    prunedInputConditions.push({ ...condition, inputs: filtered });
  }

  if (!validationChanged && !conditionsChanged) return rules;

  return {
    ...rules,
    validation: { ...(rules.validation ?? {}), inputs: prunedValidationInputs },
    input_conditions: prunedInputConditions,
  };
}

export function isWorkflowInputRequired(
  rules: WorkflowRules | null | undefined,
  inputId: string,
): boolean {
  return rules?.nodes?.[inputId]?.present?.required !== false;
}

function hasExplicitInputValidation(
  rules: WorkflowRules | null | undefined,
): boolean {
  return Boolean(rules?.validation?.inputs?.length);
}

function resolveInputValidationRules(
  rules: WorkflowRules | null | undefined,
): WorkflowInputValidationRule[] {
  if (!rules) {
    return [];
  }

  if (rules.validation?.inputs?.length) {
    return rules.validation.inputs;
  }

  const conditions = rules.input_conditions ?? [];
  return conditions.map((condition) => ({
    kind: "at_least_n" as const,
    inputs: condition.inputs ?? [],
    min: 1,
    ...(condition.message ? { message: condition.message } : {}),
  }));
}

function messageForValidationRule(rule: WorkflowInputValidationRule): string {
  if (rule.message?.trim()) {
    return rule.message.trim();
  }

  if (rule.kind === "required") {
    return `Input '${rule.input}' is required.`;
  }

  if (rule.kind === "at_least_n") {
    const listedInputs = (rule.inputs ?? []).join(", ");
    if (rule.min === 1) {
      return `Provide at least one of the following inputs: ${listedInputs}`;
    }
    return `Provide at least ${rule.min} of the following inputs: ${listedInputs}`;
  }

  return "";
}

function buildApplicableValidationTargets(
  workflowInputs: readonly WorkflowInput[],
): ReadonlySet<string> {
  const targets = new Set<string>();

  for (const input of workflowInputs) {
    targets.add(getWorkflowInputId(input));
    targets.add(input.nodeId);
  }

  return targets;
}

function resolveApplicableValidationRule(
  rule: WorkflowInputValidationRule,
  applicableTargets: ReadonlySet<string> | null,
): WorkflowInputValidationRule | null {
  if (!applicableTargets) {
    return rule;
  }

  if (rule.kind === "required" || rule.kind === "optional") {
    return applicableTargets.has(rule.input) ? rule : null;
  }

  const filteredInputs = Array.from(
    new Set((rule.inputs ?? []).filter((inputId) => applicableTargets.has(inputId))),
  );
  if (filteredInputs.length === 0) {
    return null;
  }

  return {
    ...rule,
    inputs: filteredInputs,
    min: Math.min(rule.min, filteredInputs.length),
  };
}

export function findUnsatisfiedInputValidationRules(
  rules: WorkflowRules | null | undefined,
  providedInputIds: ReadonlySet<string>,
  workflowInputs?: readonly WorkflowInput[],
): WorkflowInputValidationFailure[] {
  const applicableTargets =
    workflowInputs !== undefined
      ? buildApplicableValidationTargets(workflowInputs)
      : null;

  return resolveInputValidationRules(rules).flatMap<WorkflowInputValidationFailure>(
    (rawRule) => {
      const rule = resolveApplicableValidationRule(rawRule, applicableTargets);
      if (!rule) {
        return [];
      }

      if (rule.kind === "optional") {
        return [];
      }

      if (rule.kind === "required") {
        if (providedInputIds.has(rule.input)) {
          return [];
        }
        return [
          {
            kind: rule.kind,
            input: rule.input,
            message: messageForValidationRule(rule),
          },
        ];
      }

      const ruleInputs = rule.inputs ?? [];
      const provided = ruleInputs.filter((inputId) =>
        providedInputIds.has(inputId),
      ).length;
      if (provided >= rule.min) {
        return [];
      }

      return [
        {
          kind: rule.kind,
          inputs: ruleInputs,
          min: rule.min,
          provided,
          message: messageForValidationRule(rule),
        },
      ];
    },
  );
}

export function findMissingRequiredWorkflowInputs(
  workflowInputs: readonly WorkflowInput[],
  rules: WorkflowRules | null | undefined,
  providedInputIds: ReadonlySet<string>,
): WorkflowInputValidationFailure[] {
  if (hasExplicitInputValidation(rules)) {
    return [];
  }

  return workflowInputs.flatMap((input) => {
    if (input.inputType === "text") {
      return [];
    }
    const inputId = getWorkflowInputId(input);
    const isProvided =
      providedInputIds.has(inputId) || providedInputIds.has(input.nodeId);
    if (!isWorkflowInputRequired(rules, input.nodeId)) {
      return [];
    }
    if (isProvided) {
      return [];
    }
    return [
      {
        kind: "required",
        input: input.nodeId,
        message: `${input.label} is required.`,
      },
    ];
  });
}

export function findWorkflowInputValidationFailures(
  workflowInputs: readonly WorkflowInput[],
  rules: WorkflowRules | null | undefined,
  providedInputIds: ReadonlySet<string>,
): WorkflowInputValidationFailure[] {
  const explicitOrLegacy = findUnsatisfiedInputValidationRules(
    rules,
    providedInputIds,
    workflowInputs,
  );
  const legacyRequired = findMissingRequiredWorkflowInputs(
    workflowInputs,
    rules,
    providedInputIds,
  );
  return [...legacyRequired, ...explicitOrLegacy];
}

export function isWorkflowInputValidationSatisfied(
  workflowInputs: readonly WorkflowInput[],
  rules: WorkflowRules | null | undefined,
  providedInputIds: ReadonlySet<string>,
): boolean {
  return (
    findWorkflowInputValidationFailures(
      workflowInputs,
      rules,
      providedInputIds,
    ).length === 0
  );
}

export function findUnsatisfiedInputConditions(
  rules: WorkflowRules | null | undefined,
  providedInputIds: ReadonlySet<string>,
): WorkflowInputCondition[] {
  const conditions = rules?.input_conditions;
  if (!conditions || conditions.length === 0) {
    return [];
  }

  return conditions.filter((condition) => {
    if (condition.kind !== "at_least_one") {
      return false;
    }
    return !(condition.inputs ?? []).some((inputId) =>
      providedInputIds.has(inputId),
    );
  });
}

export function areInputConditionsSatisfied(
  rules: WorkflowRules | null | undefined,
  providedInputIds: ReadonlySet<string>,
): boolean {
  return findUnsatisfiedInputConditions(rules, providedInputIds).length === 0;
}
