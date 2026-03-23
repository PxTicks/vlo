import { create } from "zustand";
import { createConnectionSlice } from "./store/createConnectionSlice";
import { createExecutionSlice } from "./store/createExecutionSlice";
import { createJobSlice } from "./store/createJobSlice";
import { createWorkflowSlice } from "./store/createWorkflowSlice";
import type { GenerationStore } from "./store/types";

export { TEMP_WORKFLOW_ID } from "./store/constants";
export type {
  ComfyUIConnectionStatus,
  PreviewAnimation,
} from "./store/types";

export const useGenerationStore = create<GenerationStore>((set, get) => ({
  ...createWorkflowSlice(set, get),
  ...createConnectionSlice(set, get),
  ...createJobSlice(set, get),
  ...createExecutionSlice(set, get),
}));
