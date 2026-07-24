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

const UNGROUPED_WORKFLOW_GROUP_ORDER = 1_000_000;

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

export function isTemporaryWorkflowPersistenceId(
  workflowId: string | null,
): boolean {
  if (!workflowId) return false;
  if (workflowId === TEMP_WORKFLOW_ID) return true;

  const normalizedWorkflowId = normalizeWorkflowFilename(workflowId);
  const normalizedTempWorkflowId = normalizeWorkflowFilename(TEMP_WORKFLOW_ID);
  if (!normalizedWorkflowId || !normalizedTempWorkflowId) {
    return false;
  }

  return (
    normalizedWorkflowId === normalizedTempWorkflowId ||
    isTemporaryWorkflowDuplicateFilename(
      normalizedWorkflowId,
      normalizedTempWorkflowId,
    )
  );
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
    !isTemporaryWorkflowPersistenceId(selectedWorkflowId) &&
    isSafeWorkflowFilename(selectedWorkflowId)
      ? normalizeWorkflowFilename(selectedWorkflowId)
      : null;

  const persistedFilename =
    normalizedFilename && !isTemporaryWorkflowPersistenceId(normalizedFilename)
      ? normalizedFilename
      : null;
  if (
    persistedFilename &&
    normalizedSelectedWorkflowId &&
    isTemporaryWorkflowDuplicateFilename(
      persistedFilename,
      normalizedSelectedWorkflowId,
    )
  ) {
    return normalizedSelectedWorkflowId;
  }
  if (persistedFilename) {
    return persistedFilename;
  }

  if (normalizedSelectedWorkflowId) {
    return normalizedSelectedWorkflowId;
  }

  return null;
}

export function sortWorkflowOptions(
  workflows: WorkflowOption[],
): WorkflowOption[] {
  return [...workflows].sort((a, b) => {
    const orderDifference =
      (a.groupOrder ?? UNGROUPED_WORKFLOW_GROUP_ORDER) -
      (b.groupOrder ?? UNGROUPED_WORKFLOW_GROUP_ORDER);
    if (orderDifference !== 0) return orderDifference;

    const groupNameDifference = (a.groupName ?? "").localeCompare(
      b.groupName ?? "",
    );
    if (groupNameDifference !== 0) return groupNameDifference;

    return a.name.localeCompare(b.name);
  });
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
