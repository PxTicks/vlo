import { createDefaultWorkflowRules, type WorkflowRuleWarning, type WorkflowRules } from "./types";

function toRulesWarning(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): WorkflowRuleWarning {
  return {
    code,
    message,
    ...(details ? { details } : {}),
  };
}

export function normalizeWorkflowRules(rawRules: unknown): {
  rules: WorkflowRules;
  warnings: WorkflowRuleWarning[];
} {
  if (rawRules == null) {
    return { rules: createDefaultWorkflowRules(), warnings: [] };
  }

  if (typeof rawRules !== "object" || Array.isArray(rawRules)) {
    return {
      rules: createDefaultWorkflowRules(),
      warnings: [
        toRulesWarning(
          "invalid_workflow_rules",
          "Workflow rules must be an object",
        ),
      ],
    };
  }

  const rules = createDefaultWorkflowRules(rawRules as Partial<WorkflowRules>);
  return { rules, warnings: [] };
}
