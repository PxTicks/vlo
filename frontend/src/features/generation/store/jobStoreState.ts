import * as comfyApi from "../services/comfyuiApi";
import { clearJobEntry } from "./jobMutations";
import type { GenerationJobState, GenerationStoreGet, GenerationStoreSet } from "./types";

export function buildJobStoreState(
  set: GenerationStoreSet,
  get: GenerationStoreGet,
): GenerationJobState {
  return {
    jobs: new Map(),
    jobPreviewFrames: new Map(),
    activeJobId: null,
    latestPreviewUrl: null,
    previewAnimation: null,

    importOutput: async (jobId, outputIndex) => {
      const { jobs } = get();
      const job = jobs.get(jobId);
      if (!job || !job.outputs[outputIndex]) return;

      const output = job.outputs[outputIndex];
      const file = await comfyApi.fetchOutputAsFile(
        output.filename,
        output.subfolder,
        output.type,
      );

      const { addLocalAsset } = await import("../../userAssets");
      await addLocalAsset(file);
    },

    clearJob: (jobId) =>
      set((state) => clearJobEntry(state, jobId)),
  };
}
