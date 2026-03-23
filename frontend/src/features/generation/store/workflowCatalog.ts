import {
  isTemporaryWorkflowDuplicateFilename,
  isSafeWorkflowFilename,
  normalizeWorkflowFilename,
} from "../services/workflowFilenames";
import {
  TEMP_WORKFLOW_DISPLAY_NAME,
  TEMP_WORKFLOW_ID,
} from "./constants";
import type { TempWorkflow, WorkflowOption } from "./types";

export function resolveWorkflowDisplayName(
  availableWorkflows: WorkflowOption[],
  selectedWorkflowId: string | null,
  workflowId: string | null,
): string {
  const bySelectedId = selectedWorkflowId
    ? availableWorkflows.find((workflow) => workflow.id === selectedWorkflowId)
    : null;
  if (bySelectedId?.name) return bySelectedId.name;

  const byWorkflowId = workflowId
    ? availableWorkflows.find((workflow) => workflow.id === workflowId)
    : null;
  if (byWorkflowId?.name) return byWorkflowId.name;

  return workflowId ?? selectedWorkflowId ?? "Unknown Workflow";
}

export function formatWorkflowName(filename: string): string {
  return filename.replace(/\.json$/i, "");
}

export function resolveWorkflowPersistenceId(
  selectedWorkflowId: string | null,
  filename: string | null,
): string | null {
  const normalizedFilename =
    filename && isSafeWorkflowFilename(filename)
      ? normalizeWorkflowFilename(filename)
      : null;
  const normalizedSelectedWorkflowId =
    selectedWorkflowId &&
    selectedWorkflowId !== TEMP_WORKFLOW_ID &&
    isSafeWorkflowFilename(selectedWorkflowId)
      ? normalizeWorkflowFilename(selectedWorkflowId)
      : null;
  if (
    normalizedFilename &&
    normalizedSelectedWorkflowId &&
    isTemporaryWorkflowDuplicateFilename(
      normalizedFilename,
      normalizedSelectedWorkflowId,
    )
  ) {
    return normalizedSelectedWorkflowId;
  }
  if (normalizedFilename) {
    return normalizedFilename;
  }

  if (normalizedSelectedWorkflowId) {
    return normalizedSelectedWorkflowId;
  }

  return null;
}

export function sortWorkflowOptions(
  workflows: WorkflowOption[],
): WorkflowOption[] {
  return [...workflows].sort((a, b) => a.name.localeCompare(b.name));
}

export function upsertWorkflowOption(
  workflows: WorkflowOption[],
  workflow: WorkflowOption,
): WorkflowOption[] {
  const existingIndex = workflows.findIndex((item) => item.id === workflow.id);
  const next = [...workflows];

  if (existingIndex >= 0) {
    next[existingIndex] = workflow;
  } else {
    next.push(workflow);
  }

  return sortWorkflowOptions(next);
}

export function removeWorkflowOption(
  workflows: WorkflowOption[],
  workflowId: string,
): WorkflowOption[] {
  return workflows.filter((workflow) => workflow.id !== workflowId);
}

export function resolveTempWorkflowDisplayName(
  tempWorkflow: TempWorkflow | null,
): string {
  return tempWorkflow?.name ?? TEMP_WORKFLOW_DISPLAY_NAME;
}

export function upsertTempWorkflowOption(
  workflows: WorkflowOption[],
  tempWorkflow: TempWorkflow,
): WorkflowOption[] {
  return upsertWorkflowOption(workflows, {
    id: TEMP_WORKFLOW_ID,
    name: resolveTempWorkflowDisplayName(tempWorkflow),
  });
}
