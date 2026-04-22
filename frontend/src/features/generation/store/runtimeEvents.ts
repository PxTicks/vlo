import * as comfyApi from "../services/comfyuiApi";
import type {
  ComfyUIEvent,
  ComfyUIPreview,
  ComfyUIWebSocket,
} from "../services/ComfyUIWebSocket";
import { parseNodeOutputItems, parseQueuePromptIds } from "../services/parsers";
import { frontendPostprocess } from "../utils/pipeline";
import {
  getHistoryOutputsWithRetry,
  getPromptHistoryStateWithRetry,
} from "./history";
import {
  applyExecutingNode,
  applyJobProgress,
  appendJobOutputs,
  applyPreviewUpdate,
  completeGenerationJob,
  isActiveGenerationJob,
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
  const finalizingPromptIds = new Set<string>();
  let hasSeenConnectedState = false;
  let recoveryInFlight = false;

  async function finalizeCompletedJob(promptId: string): Promise<void> {
    if (finalizingPromptIds.has(promptId)) {
      return;
    }

    const state = get();
    const job = state.jobs.get(promptId);
    if (!job || job.status === "error" || job.status === "completed") {
      return;
    }

    finalizingPromptIds.add(promptId);

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
      resumeQueuedDispatch();
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
      resumeQueuedDispatch();
      if (completedJob) {
        void runJobPostprocess(completedJob);
      }
    } finally {
      finalizingPromptIds.delete(promptId);
    }
  }

  async function runJobPostprocess(
    jobSnapshot: import("../types").GenerationJob,
  ): Promise<void> {
    const previewFrameFiles = jobSnapshot.usesSaveImageWebsocketOutputs
      ? get().jobPreviewFrames.get(jobSnapshot.id) ?? []
      : [];
    if (jobSnapshot.outputs.length === 0 && previewFrameFiles.length === 0) {
      set((state) => {
        const hadPreviewFrames = state.jobPreviewFrames.has(jobSnapshot.id);
        const nextPreviewFrames = hadPreviewFrames
          ? new Map(state.jobPreviewFrames)
          : null;
        nextPreviewFrames?.delete(jobSnapshot.id);
        const nextPostprocessingJobIds = state.postprocessingJobIds.filter(
          (jobId) => jobId !== jobSnapshot.id,
        );

        return {
          ...(nextPreviewFrames ? { jobPreviewFrames: nextPreviewFrames } : {}),
          postprocessingJobIds: nextPostprocessingJobIds,
        };
      });
      return;
    }
    const generationMetadata =
      jobSnapshot.generationMetadata ?? {
        source: "generated",
        workflowName: "Unknown Workflow",
        inputs: [],
      };

    set((state) => {
      if (state.postprocessingJobIds.includes(jobSnapshot.id)) {
        return {};
      }

      return {
        postprocessingJobIds: [...state.postprocessingJobIds, jobSnapshot.id],
      };
    });

    try {
      const postprocessResult = await frontendPostprocess(jobSnapshot.outputs, {
        postprocessing: jobSnapshot.postprocessConfig,
        aspectRatioProcessing: jobSnapshot.aspectRatioProcessing,
        generationMetadata,
        autoFamilyRequestKey: jobSnapshot.autoFamilyRequestKey,
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
        const nextPreviewFrames = hasPreviewFrames
          ? new Map(state.jobPreviewFrames)
          : null;
        nextPreviewFrames?.delete(jobSnapshot.id);
        return {
          ...(nextPreviewFrames ? { jobPreviewFrames: nextPreviewFrames } : {}),
          postprocessingJobIds: state.postprocessingJobIds.filter(
            (jobId) => jobId !== jobSnapshot.id,
          ),
        };
      });
    }
  }

  function resumeQueuedDispatch(): void {
    void get().processGenerationQueue();
  }

  async function recoverIncompleteJobs(): Promise<void> {
    // Reconnects do not replay missed websocket events, so reconcile any
    // locally-known in-flight prompts against ComfyUI history/queue state.
    const incompleteJobs = Array.from(get().jobs.values()).filter((job) =>
      isActiveGenerationJob(job) && !job.deliveryId,
    );
    if (incompleteJobs.length === 0) {
      return;
    }

    let queuePromptIds: Set<string> | null = null;
    try {
      const queue = await comfyApi.getQueue();
      queuePromptIds = parseQueuePromptIds(queue);
    } catch (error) {
      console.warn("[Generation] Failed to fetch queue during recovery", error);
    }

    for (const job of incompleteJobs) {
      const latestJob = get().jobs.get(job.id);
      if (!latestJob || !isActiveGenerationJob(latestJob)) {
        continue;
      }

      let historyLookupSucceeded = false;
      try {
        const historyState = await getPromptHistoryStateWithRetry(job.id);
        historyLookupSucceeded = true;
        if (historyState.hasPromptEntry) {
          void finalizeCompletedJob(job.id);
          continue;
        }
      } catch (error) {
        console.warn(
          "[Generation] Failed to fetch history during reconnect recovery",
          error,
        );
      }

      if (
        historyLookupSucceeded &&
        queuePromptIds !== null &&
        !queuePromptIds.has(job.id)
      ) {
        set((state) =>
          markJobError(
            state,
            job.id,
            "Generation status could not be recovered after reconnect",
            null,
            {
              clearActiveJob: state.activeJobId === job.id,
              completedAt: Date.now(),
            },
          ),
        );
      }
    }

    resumeQueuedDispatch();
  }

  function scheduleIncompleteJobRecovery(): void {
    if (recoveryInFlight) {
      return;
    }

    recoveryInFlight = true;
    void recoverIncompleteJobs().finally(() => {
      recoveryInFlight = false;
    });
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
          if (get().editorNeedsReconnect) {
            get().requestEditorReconnect();
          }
        }
        resumeQueuedDispatch();
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

      case "execution_start":
      case "execution_cached": {
        break;
      }

      case "execution_success": {
        void finalizeCompletedJob(event.data.prompt_id);
        break;
      }

      case "executing": {
        if (event.data.node === null) {
          const state = get();
          const job = state.jobs.get(event.data.prompt_id);
          if (job && job.status !== "error") {
            void finalizeCompletedJob(event.data.prompt_id);
          }
        } else {
          const currentNode = event.data.node;
          set((state) =>
            applyExecutingNode(state, event.data.prompt_id, currentNode),
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
        resumeQueuedDispatch();
        break;
      }

      case "execution_interrupted": {
        set((state) => {
          const job = state.jobs.get(event.data.prompt_id);
          if (!job || job.status === "error" || job.status === "completed") {
            return {};
          }

          return markJobError(
            state,
            event.data.prompt_id,
            "Generation interrupted",
            event.data.node_id,
            {
              clearActiveJob: state.activeJobId === event.data.prompt_id,
              completedAt: Date.now(),
            },
          );
        });
        resumeQueuedDispatch();
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
        resumeQueuedDispatch();
        break;
      }
    }
  });

  client.onPreview((preview: ComfyUIPreview) => {
    set((state) => applyPreviewUpdate(state, preview));
  });

  client.onConnectionChange((wsState) => {
    if (wsState === "connected") {
      const shouldRecover = hasSeenConnectedState;
      hasSeenConnectedState = true;
      void get().refreshRuntimeStatus();
      if (get().connectionStatus !== "connected") {
        set({ connectionStatus: "connecting" });
      }
      if (shouldRecover) {
        scheduleIncompleteJobRecovery();
      }
      resumeQueuedDispatch();
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
