import * as comfyApi from "../services/comfyuiApi";
import type { GenerationJob } from "../types";

function getSubmissionErrorMessage(error: unknown): string {
  if (error instanceof comfyApi.ComfyApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Generation request failed before execution";
}

function getSubmissionErrorNode(error: unknown): string | null {
  if (!(error instanceof comfyApi.ComfyApiError) || !error.nodeErrors) {
    return null;
  }

  const nodeIds = Object.keys(error.nodeErrors);
  return nodeIds.length > 0 ? nodeIds[0] : null;
}

export function createSubmissionErrorJob(error: unknown): GenerationJob {
  return {
    id: `submission-error-${crypto.randomUUID()}`,
    status: "error",
    progress: 0,
    currentNode: getSubmissionErrorNode(error),
    outputs: [],
    error: getSubmissionErrorMessage(error),
    submittedAt: Date.now(),
    completedAt: Date.now(),
  };
}
