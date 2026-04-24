import type { GenerationPipelineStatus } from "../types";

export const TEMP_WORKFLOW_ID = "__temp__";
export const TEMP_WORKFLOW_DISPLAY_NAME = "Edited Workflow";
export const LOADED_WORKFLOW_DISPLAY_NAME = "loaded workflow";
export const GENERATION_CANCELLED_BY_USER_MESSAGE =
  "Generation cancelled by user";
export const GENERATION_INTERRUPTED_MESSAGE = "Generation interrupted";

export const IDLE_PIPELINE_STATUS: GenerationPipelineStatus = {
  phase: "idle",
  message: null,
  interruptible: false,
};

export function isGenerationInterruptionMessage(
  message: string | null | undefined,
): boolean {
  return (
    message === GENERATION_CANCELLED_BY_USER_MESSAGE ||
    message === GENERATION_INTERRUPTED_MESSAGE
  );
}
