import type { GenerationPipelineStatus } from "../types";

export const TEMP_WORKFLOW_ID = "__temp__";
export const TEMP_WORKFLOW_DISPLAY_NAME = "Edited Workflow";
export const LOADED_WORKFLOW_DISPLAY_NAME = "loaded workflow";

export const IDLE_PIPELINE_STATUS: GenerationPipelineStatus = {
  phase: "idle",
  message: null,
  interruptible: false,
};
