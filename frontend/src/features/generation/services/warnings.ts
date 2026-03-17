import type { WorkflowRuleWarning } from "./workflowRules";

export function mergeRuleWarnings(
  ...warningGroups: Array<WorkflowRuleWarning[] | null | undefined>
): WorkflowRuleWarning[] {
  const merged: WorkflowRuleWarning[] = [];
  const seen = new Set<string>();

  for (const warnings of warningGroups) {
    if (!warnings) continue;
    for (const warning of warnings) {
      const key = JSON.stringify(warning);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(warning);
    }
  }

  return merged;
}
