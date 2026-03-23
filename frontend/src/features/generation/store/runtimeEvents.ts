import type {
  ComfyUIEvent,
  ComfyUIPreview,
  ComfyUIWebSocket,
} from "../services/ComfyUIWebSocket";
import { parseNodeOutputItems } from "../services/parsers";
import { frontendPostprocess } from "../utils/pipeline";
import { IDLE_PIPELINE_STATUS } from "./constants";
import { getHistoryOutputsWithRetry } from "./history";
import {
  applyExecutingNode,
  applyJobProgress,
  appendJobOutputs,
  applyPreviewUpdate,
  completeGenerationJob,
  markActiveJobError,
  markJobError,
  setJobPostprocessResult,
} from "./jobMutations";
import type { GenerationStoreGet, GenerationStoreSet } from "./types";

export function attachRuntimeClientHandlers(
  client: ComfyUIWebSocket,
  set: GenerationStoreSet,
  get: GenerationStoreGet,
): void {
  async function runJobPostprocess(
    jobSnapshot: import("../types").GenerationJob,
  ) {
    const previewFrameFiles = jobSnapshot.usesSaveImageWebsocketOutputs
      ? get().jobPreviewFrames.get(jobSnapshot.id) ?? []
      : [];
    if (jobSnapshot.outputs.length === 0 && previewFrameFiles.length === 0) {
      set((state) => {
        if (!state.jobPreviewFrames.has(jobSnapshot.id)) return {};
        const nextPreviewFrames = new Map(state.jobPreviewFrames);
        nextPreviewFrames.delete(jobSnapshot.id);
        return { jobPreviewFrames: nextPreviewFrames };
      });
      return;
    }
    const generationMetadata =
      jobSnapshot.generationMetadata ?? {
        source: "generated",
        workflowName: "Unknown Workflow",
        inputs: [],
      };

    set({
      pipelineStatus: {
        phase: "postprocessing",
        message: "Rendering generation",
        interruptible: false,
      },
    });

    try {
      const postprocessResult = await frontendPostprocess(jobSnapshot.outputs, {
        postprocessing: jobSnapshot.postprocessConfig,
        aspectRatioProcessing: jobSnapshot.aspectRatioProcessing,
        generationMetadata,
        previewFrameFiles,
        preparedMaskFile: jobSnapshot.preparedMaskFile,
      });
      set((state) =>
        setJobPostprocessResult(state, jobSnapshot.id, {
          postprocessedPreview: postprocessResult.postprocessedPreview,
          postprocessError: postprocessResult.postprocessError,
          importedAssetIds: postprocessResult.importedAssetIds,
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Postprocessing failed unexpectedly";
      console.error("[Generation] Auto-import failed:", error);
      set((state) =>
        setJobPostprocessResult(state, jobSnapshot.id, {
          postprocessedPreview: null,
          postprocessError: message,
        }),
      );
    } finally {
      set((state) => {
        const hasPreviewFrames = state.jobPreviewFrames.has(jobSnapshot.id);
        if (!hasPreviewFrames && state.pipelineStatus.phase !== "postprocessing") {
          return {};
        }

        const nextPreviewFrames = hasPreviewFrames
          ? new Map(state.jobPreviewFrames)
          : null;
        nextPreviewFrames?.delete(jobSnapshot.id);

        return {
          ...(nextPreviewFrames ? { jobPreviewFrames: nextPreviewFrames } : {}),
          ...(state.pipelineStatus.phase === "postprocessing"
            ? { pipelineStatus: IDLE_PIPELINE_STATUS }
            : {}),
        };
      });
    }
  }

  client.onEvent((event: ComfyUIEvent) => {
    switch (event.type) {
      case "status": {
        if (get().connectionStatus !== "connected") {
          set((state) => ({
            connectionStatus: "connected",
            runtimeStatus: state.runtimeStatus
              ? {
                  ...state.runtimeStatus,
                  comfyui: {
                    ...state.runtimeStatus.comfyui,
                    status: "connected",
                    error: null,
                  },
                }
              : state.runtimeStatus,
            runtimeStatusError: null,
          }));
          void get().fetchWorkflows();
          get().requestEditorReconnect();
        }
        break;
      }

      case "progress": {
        set((state) =>
          applyJobProgress(
            state,
            event.data.prompt_id,
            Math.round((event.data.value / event.data.max) * 100),
            event.data.node,
          ),
        );
        break;
      }

      case "executing": {
        if (event.data.node === null) {
          const state = get();
          const job = state.jobs.get(event.data.prompt_id);
          if (job && job.status !== "error") {
            const promptId = event.data.prompt_id;

            void (async () => {
              try {
                const finalOutputs = await getHistoryOutputsWithRetry(promptId);
                let completedJob: import("../types").GenerationJob | null = null;
                set((currentState) => {
                  const result = completeGenerationJob(
                    currentState,
                    promptId,
                    finalOutputs.length > 0 ? finalOutputs : undefined,
                  );
                  completedJob = result.completedJob;
                  return result.patch;
                });
                if (completedJob) {
                  void runJobPostprocess(completedJob);
                }
              } catch (err) {
                console.error(
                  "[Generation] Failed to fetch history for completed job",
                  err,
                );
                let completedJob: import("../types").GenerationJob | null = null;
                set((currentState) => {
                  const result = completeGenerationJob(currentState, promptId);
                  completedJob = result.completedJob;
                  return result.patch;
                });
                if (completedJob) {
                  void runJobPostprocess(completedJob);
                }
              }
            })();
          }
        } else {
          set((state) =>
            applyExecutingNode(state, event.data.prompt_id, event.data.node),
          );
        }
        break;
      }

      case "executed": {
        const newOutputs = parseNodeOutputItems(event.data.output);
        if (newOutputs.length === 0) break;
        set((state) =>
          appendJobOutputs(state, event.data.prompt_id, newOutputs),
        );
        break;
      }

      case "execution_error": {
        set((state) =>
          markJobError(
            state,
            event.data.prompt_id,
            event.data.exception_message,
            event.data.node_id,
          ),
        );
        break;
      }

      case "error": {
        console.warn("[Generation] Proxy error:", event.data.message);
        void get().refreshRuntimeStatus();
        set((state) =>
          markActiveJobError(state, event.data.message, {
            nextConnectionStatus: "error",
            completedAt: Date.now(),
          }),
        );
        break;
      }
    }
  });

  client.onPreview((preview: ComfyUIPreview) => {
    set((state) => applyPreviewUpdate(state, preview));
  });

  client.onConnectionChange((wsState) => {
    if (wsState === "connected") {
      void get().refreshRuntimeStatus();
      if (get().connectionStatus !== "connected") {
        set({ connectionStatus: "connecting" });
      }
    } else {
      set((state) => ({
        connectionStatus: "disconnected",
        runtimeStatus: state.runtimeStatus
          ? {
              ...state.runtimeStatus,
              comfyui: {
                ...state.runtimeStatus.comfyui,
                status: "disconnected",
              },
            }
          : state.runtimeStatus,
      }));
      void get().refreshRuntimeStatus();
    }
  });
}
