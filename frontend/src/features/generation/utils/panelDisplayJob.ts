import type { GenerationJob } from "../types";

const NON_PERSISTENT_GENERATION_ERRORS = new Set([
  "Generation interrupted",
  "Generation cancelled by user",
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
