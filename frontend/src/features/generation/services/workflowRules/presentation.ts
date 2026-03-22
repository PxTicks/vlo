import type { WorkflowInput } from "../../types";
import type {
  DerivedMaskMapping,
  ResolvePresentedInputsResult,
  WorkflowRuleNodePresent,
  WorkflowRuleWarning,
  WorkflowRules,
} from "./types";
import { normalizeWorkflowRules } from "./normalize";
import {
  toRulesWarning,
  toSelectionConfig,
  toWorkflowInputType,
} from "./shared";
import { buildWorkflowInputId, getWorkflowInputId } from "../../utils/workflowInputs";

function hasPresentOverrides(
  present: WorkflowRuleNodePresent | undefined,
): boolean {
  if (!present) return false;
  const keys = Object.keys(present);
  return keys.some((key) => key !== "enabled");
}

type ConditioningRole = "positive" | "negative";

function toConditioningRole(value: string | undefined): ConditioningRole | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("positive")) return "positive";
  if (normalized.includes("negative")) return "negative";
  return null;
}

function toConditioningLabel(role: ConditioningRole): string {
  return role === "positive" ? "Positive Prompt" : "Negative Prompt";
}

function applyConditioningRoleToLabel(
  label: string,
  role: ConditioningRole,
): string {
  const rolePrefix = role === "positive" ? "Positive" : "Negative";
  if (label.trim().toLowerCase() === "prompt") {
    return toConditioningLabel(role);
  }
  if (label.toLowerCase().includes("prompt")) {
    return `${rolePrefix} ${label}`;
  }
  return `${toConditioningLabel(role)} (${label})`;
}

function resolveConditioningRoles(
  inferredInputs: WorkflowInput[],
  workflow: Record<string, unknown> | null | undefined,
): Map<string, ConditioningRole> {
  const roles = new Map<string, ConditioningRole>();
  const directlyResolvedNodeIds = new Set<string>();
  const ambiguousDirectNodeIds = new Set<string>();

  for (const input of inferredInputs) {
    if (input.inputType !== "text") continue;
    const role = toConditioningRole(input.label);
    if (role) {
      roles.set(input.nodeId, role);
    }
  }

  if (!workflow) return roles;

  for (const node of Object.values(workflow)) {
    if (!isRecord(node)) continue;
    const nodeInputs = isRecord(node.inputs) ? node.inputs : {};

    for (const [inputName, inputValue] of Object.entries(nodeInputs)) {
      const role = toConditioningRole(inputName);
      if (!role) continue;
      if (!Array.isArray(inputValue) || typeof inputValue[0] !== "string") {
        continue;
      }

      const sourceNodeId = inputValue[0];
      if (ambiguousDirectNodeIds.has(sourceNodeId)) continue;

      const existing = roles.get(sourceNodeId);
      if (
        directlyResolvedNodeIds.has(sourceNodeId) &&
        existing &&
        existing !== role
      ) {
        roles.delete(sourceNodeId);
        ambiguousDirectNodeIds.add(sourceNodeId);
        continue;
      }

      roles.set(sourceNodeId, role);
      directlyResolvedNodeIds.add(sourceNodeId);
    }
  }

  return roles;
}

function sortConditioningInputs(
  inputs: WorkflowInput[],
  conditioningRoles: ReadonlyMap<string, ConditioningRole>,
): WorkflowInput[] {
  const indexedConditioningInputs = inputs
    .map((input, index) => ({
      index,
      input,
      role:
        input.inputType === "text"
          ? (conditioningRoles.get(input.nodeId) ?? null)
          : null,
    }))
    .filter(
      (
        entry,
      ): entry is {
        index: number;
        input: WorkflowInput;
        role: ConditioningRole;
      } => entry.role !== null,
    );

  if (indexedConditioningInputs.length < 2) return inputs;

  const hasPositive = indexedConditioningInputs.some(
    (entry) => entry.role === "positive",
  );
  const hasNegative = indexedConditioningInputs.some(
    (entry) => entry.role === "negative",
  );
  if (!hasPositive || !hasNegative) return inputs;

  const sorted = [...indexedConditioningInputs].sort((left, right) => {
    if (left.role === right.role) return left.index - right.index;
    return left.role === "positive" ? -1 : 1;
  });
  const nextInputs = [...inputs];

  indexedConditioningInputs.forEach((entry, orderIndex) => {
    nextInputs[entry.index] = sorted[orderIndex].input;
  });

  return nextInputs;
}

export function resolvePresentedInputsFromRules(
  inferredInputs: WorkflowInput[],
  rules: WorkflowRules,
  workflow?: Record<string, unknown> | null,
  initialWarnings: WorkflowRuleWarning[] = [],
): ResolvePresentedInputsResult {
  const presentationWarnings: WorkflowRuleWarning[] = [...initialWarnings];
  const inferredMap = new Map(
    inferredInputs.map((input) => [input.nodeId, input]),
  );
  const inferredByNodeId = new Map<string, WorkflowInput[]>();
  for (const input of inferredInputs) {
    const existing = inferredByNodeId.get(input.nodeId) ?? [];
    existing.push(input);
    inferredByNodeId.set(input.nodeId, existing);
  }
  const conditioningRoles = resolveConditioningRoles(inferredInputs, workflow);
  const resolved: WorkflowInput[] = [];
  const derivedMaskMappings: DerivedMaskMapping[] = [];

  for (const inferred of inferredInputs) {
    const nodeRule = rules.nodes[inferred.nodeId];
    const present = nodeRule?.present;
    const selectionConfig = toSelectionConfig(nodeRule?.selection);
    if (nodeRule?.ignore) {
      continue;
    }
    if (present?.enabled === false) {
      continue;
    }

    // Nodes with a derived mask rule are hidden from the UI; they are
    // auto-populated during preprocessing with the rendered mask.
    const derivedMask = nodeRule?.binary_derived_mask_of
      ? ({ sourceNodeId: nodeRule.binary_derived_mask_of, maskType: "binary" } as const)
      : nodeRule?.soft_derived_mask_of
        ? ({ sourceNodeId: nodeRule.soft_derived_mask_of, maskType: "soft" } as const)
        : null;
    if (derivedMask) {
      derivedMaskMappings.push({
        maskNodeId: inferred.nodeId,
        maskParam: present?.param ?? inferred.param,
        sourceNodeId: derivedMask.sourceNodeId,
        sourceInputId:
          inferredByNodeId.get(derivedMask.sourceNodeId)?.length === 1
            ? getWorkflowInputId(
                inferredByNodeId.get(derivedMask.sourceNodeId)?.[0] ?? inferred,
              )
            : undefined,
        maskType: derivedMask.maskType,
      });
      continue;
    }

    const nextInput: WorkflowInput = {
      ...inferred,
      origin: nodeRule && hasPresentOverrides(present) ? "rule" : "inferred",
      dispatch:
        inferred.dispatch ??
        {
          kind: "node",
          ...(selectionConfig ? { selectionConfig } : {}),
        },
    };

    if (selectionConfig && nextInput.dispatch?.kind === "node") {
      nextInput.dispatch = {
        ...nextInput.dispatch,
        selectionConfig,
      };
    }

    if (present?.label) {
      nextInput.label = present.label;
    }
    if (present?.param) {
      nextInput.param = present.param;
    }
    if (present?.class_type) {
      nextInput.classType = present.class_type;
    }
    if (present?.input_type) {
      const mappedInputType = toWorkflowInputType(present.input_type);
      if (mappedInputType) {
        nextInput.inputType = mappedInputType;
      } else {
        presentationWarnings.push(
          toRulesWarning(
            "unsupported_present_input_type",
            `Unsupported present input type '${present.input_type}'`,
            inferred.nodeId,
          ),
        );
      }
    }

    if (!present?.label && nextInput.inputType === "text") {
      const role = conditioningRoles.get(nextInput.nodeId);
      if (role) {
        nextInput.label = applyConditioningRoleToLabel(nextInput.label, role);
      }
    }

    resolved.push(nextInput);
  }

  for (const [nodeId, nodeRule] of Object.entries(rules.nodes)) {
    if (inferredMap.has(nodeId) || nodeRule.ignore) continue;
    const present = nodeRule.present;
    const selectionConfig = toSelectionConfig(nodeRule.selection);
    if (!present || present.enabled === false) continue;
    if (!present.input_type) {
      presentationWarnings.push(
        toRulesWarning(
          "missing_present_input_type",
          "Rule-defined input requires present.input_type",
          nodeId,
        ),
      );
      continue;
    }
    const inputType = toWorkflowInputType(present.input_type);
    if (!inputType) {
      presentationWarnings.push(
        toRulesWarning(
          "unsupported_present_input_type",
          `Unsupported present input type '${present.input_type}'`,
          nodeId,
        ),
      );
      continue;
    }
    if (!present.param) {
      presentationWarnings.push(
        toRulesWarning(
          "missing_present_param",
          "Rule-defined input requires present.param",
          nodeId,
        ),
      );
      continue;
    }

    const classType = present.class_type ?? "RuleInput";
    resolved.push({
      id: buildWorkflowInputId(nodeId, present.param),
      nodeId,
      classType,
      inputType,
      param: present.param,
      label: present.label ?? classType,
      description: null,
      currentValue: null,
      origin: "rule",
      dispatch: {
        kind: "node",
        ...(selectionConfig ? { selectionConfig } : {}),
      },
    });
  }

  const sortedInputs = sortConditioningInputs(resolved, conditioningRoles);

  return {
    inputs: sortedInputs,
    widgetInputs: [],
    hasInferredInputs: sortedInputs.some((input) => input.origin === "inferred"),
    derivedMaskMappings,
    presentationWarnings,
  };
}

export function resolvePresentedInputs(
  inferredInputs: WorkflowInput[],
  rawRules: unknown,
  workflow?: Record<string, unknown> | null,
): ResolvePresentedInputsResult {
  const { rules, warnings } = normalizeWorkflowRules(rawRules);
  return resolvePresentedInputsFromRules(
    inferredInputs,
    rules,
    workflow,
    warnings,
  );
}
