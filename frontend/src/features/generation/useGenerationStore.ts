import { create } from "zustand";
import { buildExecutionStoreState } from "./store/executionStoreState";
import { buildJobStoreState } from "./store/jobStoreState";
import { buildRuntimeStoreState } from "./store/runtimeStoreState";
import { buildWorkflowStoreState } from "./store/workflowStoreState";
import type { GenerationStore } from "./store/types";

export { TEMP_WORKFLOW_ID } from "./store/constants";
export type {
  ComfyUIConnectionStatus,
  PreviewAnimation,
} from "./store/types";

export const useGenerationStore = create<GenerationStore>((set, get) => {
  let workflowLoadRequestId = 0;

  return {
    ...buildWorkflowStoreState(set, get, {
      getNextWorkflowLoadRequestId: () => {
        workflowLoadRequestId += 1;
        return workflowLoadRequestId;
      },
      isCurrentWorkflowLoadRequestId: (requestId) =>
        requestId === workflowLoadRequestId,
    }),
    ...buildRuntimeStoreState(set, get),
    ...buildJobStoreState(set, get),
    ...buildExecutionStoreState(set, get),
  };
});
