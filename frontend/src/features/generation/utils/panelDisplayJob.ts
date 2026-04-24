import type { GenerationJob } from "../types";
import {
  GENERATION_CANCELLED_BY_USER_MESSAGE,
  GENERATION_INTERRUPTED_MESSAGE,
} from "../store/constants";

const NON_PERSISTENT_GENERATION_ERRORS = new Set([
  GENERATION_INTERRUPTED_MESSAGE,
  GENERATION_CANCELLED_BY_USER_MESSAGE,
  "Generation completed without persisted final outputs for delivery",
]);

export function shouldShowHistoricalGenerationJob(
  job: Pick<GenerationJob, "status" | "error">,
): boolean {
  if (job.status !== "completed" && job.status !== "error") {
    return false;
  }

  if (
    job.status === "error" &&
    job.error !== null &&
    NON_PERSISTENT_GENERATION_ERRORS.has(job.error)
  ) {
    return false;
  }

  return true;
}
