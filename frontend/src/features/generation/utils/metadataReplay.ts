import type {
  CreationMetadata,
  GeneratedCreationMetadata,
} from "../../../types/Asset";
import * as comfyApi from "../services/comfyuiApi";
import { TEMP_WORKFLOW_ID } from "../store/constants";
import { formatWorkflowName } from "../store/workflowCatalog";
import type { WorkflowOption } from "../store/types";

const UNKNOWN_WORKFLOW_NAME = "Unknown Workflow";
/** Placeholder label the backend stamps on adopted in-editor deliveries
 * (see adopt_delivery). It is not a saved workflow, so it must never count
 * as a resolvable name: an adopted asset whose history enrichment never landed
 * has neither a captured graph nor a saved workflow to fall back to. */
const IN_EDITOR_WORKFLOW_NAME = "ComfyUI (in-editor)";

function normalizeWorkflowMatchValue(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\.json$/i, "").toLowerCase();
}

function hasResolvableWorkflowName(workflowName: string): boolean {
  const normalizedName = normalizeWorkflowMatchValue(workflowName);
  return (
    normalizedName !== null &&
    normalizedName !== normalizeWorkflowMatchValue(UNKNOWN_WORKFLOW_NAME) &&
    normalizedName !== normalizeWorkflowMatchValue(IN_EDITOR_WORKFLOW_NAME)
  );
}

function matchesMetadataWorkflowName(
  workflow: WorkflowOption,
  workflowName: string,
): boolean {
  const normalizedWorkflowName = normalizeWorkflowMatchValue(workflowName);
  if (!normalizedWorkflowName) {
    return false;
  }

  return [workflow.name, workflow.id, formatWorkflowName(workflow.id)].some(
    (candidate) =>
      normalizeWorkflowMatchValue(candidate) === normalizedWorkflowName,
  );
}

async function refreshCandidateWorkflows(
  availableWorkflows: WorkflowOption[],
): Promise<WorkflowOption[]> {
  const existingCandidates = availableWorkflows.filter(
    (workflow) => workflow.id !== TEMP_WORKFLOW_ID,
  );

  try {
    return await comfyApi.listWorkflows();
  } catch (error) {
    console.warn(
      "[Generation] Failed to refresh workflows for metadata replay:",
      error,
    );
    return existingCandidates;
  }
}

export function canRegenerateFromAssetMetadata(
  metadata: CreationMetadata | undefined,
): metadata is GeneratedCreationMetadata {
  if (metadata?.source !== "generated") {
    return false;
  }

  // The captured prompt/graph is the strongest signal, but the asset index only
  // keeps an abridged copy of generated metadata — the payload itself lives in
  // the sidecar, hydrated later by loadWorkflowFromAssetMetadata. Panel and
  // in-editor generations are split the same way, so both answer this the same
  // way after a project reload.
  return (
    Boolean(
      metadata.comfyuiPrompt ||
        metadata.comfyuiWorkflow ||
        metadata.replayPayloadInSidecar,
    ) || hasResolvableWorkflowName(metadata.workflowName)
  );
}

export async function resolveMetadataWorkflowNameMatch(
  workflowName: string,
  availableWorkflows: WorkflowOption[],
): Promise<{
  availableWorkflows: WorkflowOption[];
  matchedWorkflow: WorkflowOption | null;
}> {
  const candidateWorkflows = await refreshCandidateWorkflows(availableWorkflows);
  const matchedWorkflow =
    candidateWorkflows.find((workflow) =>
      matchesMetadataWorkflowName(workflow, workflowName),
    ) ?? null;

  return {
    availableWorkflows: candidateWorkflows,
    matchedWorkflow,
  };
}
