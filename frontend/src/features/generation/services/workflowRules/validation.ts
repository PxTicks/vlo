import type { WorkflowInput } from "../../types";
import { getWorkflowInputId } from "../../utils/workflowInputs";
import type {
  WorkflowInputCondition,
  WorkflowInputValidationFailure,
  WorkflowInputValidationRule,
  WorkflowRules,
} from "./types";

export function isWorkflowInputRequired(
  rules: WorkflowRules | null | undefined,
  inputId: string,
): boolean {
  return rules?.nodes[inputId]?.present?.required !== false;
}

function hasExplicitInputValidation(
  rules: WorkflowRules | null | undefined,
): boolean {
  return Boolean(rules?.validation?.inputs.length);
}

function resolveInputValidationRules(
  rules: WorkflowRules | null | undefined,
): WorkflowInputValidationRule[] {
  if (!rules) {
    return [];
  }

  if (rules.validation?.inputs.length) {
    return rules.validation.inputs;
  }

  const conditions = rules.input_conditions ?? [];
  return conditions.map((condition) => ({
    kind: "at_least_n" as const,
    inputs: condition.inputs,
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
    const listedInputs = rule.inputs.join(", ");
    if (rule.min === 1) {
      return `Provide at least one of the following inputs: ${listedInputs}`;
    }
    return `Provide at least ${rule.min} of the following inputs: ${listedInputs}`;
  }

  return "";
}

export function findUnsatisfiedInputValidationRules(
  rules: WorkflowRules | null | undefined,
  providedInputIds: ReadonlySet<string>,
): WorkflowInputValidationFailure[] {
  return resolveInputValidationRules(rules).flatMap<WorkflowInputValidationFailure>(
    (rule) => {
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

      const provided = rule.inputs.filter((inputId) =>
        providedInputIds.has(inputId),
      ).length;
      if (provided >= rule.min) {
        return [];
      }

      return [
        {
          kind: rule.kind,
          inputs: rule.inputs,
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
        input: inputId,
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
    return !condition.inputs.some((inputId) => providedInputIds.has(inputId));
  });
}

export function areInputConditionsSatisfied(
  rules: WorkflowRules | null | undefined,
  providedInputIds: ReadonlySet<string>,
): boolean {
  return findUnsatisfiedInputConditions(rules, providedInputIds).length === 0;
}
