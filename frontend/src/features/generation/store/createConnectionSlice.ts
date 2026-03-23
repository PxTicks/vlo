import { API_BASE_URL } from "../../../config";
import { getRuntimeStatus } from "../../../services/runtimeApi";
import {
  ComfyUIWebSocket,
  type ComfyUIEvent,
  type ComfyUIPreview,
} from "../services/ComfyUIWebSocket";
import * as comfyApi from "../services/comfyuiApi";
import { mergeInputNodeMap } from "../constants/inputNodeMap";
import { parseNodeOutputItems } from "../services/parsers";
import { frontendPostprocess } from "../utils/pipeline";
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
import { IDLE_PIPELINE_STATUS } from "./constants";
import { revokeJobPostprocessPreview, revokePreviewAnimation } from "./previewState";
import type {
  ComfyUIConnectionStatus,
  GenerationConnectionState,
  GenerationStoreGet,
  GenerationStoreSet,
} from "./types";

function connectionStatusFromRuntime(
  runtimeStatus: import("../../../types/RuntimeStatus").RuntimeStatus | null,
): ComfyUIConnectionStatus {
  if (!runtimeStatus) return "disconnected";
  if (runtimeStatus.comfyui.status === "connected") return "connected";
  if (runtimeStatus.comfyui.status === "invalid_config") return "error";
  return "disconnected";
}

export function createConnectionSlice(
  set: GenerationStoreSet,
  get: GenerationStoreGet,
): GenerationConnectionState {
  return {
    connectionStatus: "disconnected",
    runtimeStatus: null,
    runtimeStatusError: null,
    comfyuiDirectUrl: null,
    wsClient: null,
    objectInfoSynced: false,
    inputNodeMap: null,
    editorNeedsReconnect: false,
    editorReconnectSignal: 0,

    setEditorNeedsReconnect: (required) =>
      set({ editorNeedsReconnect: required }),

    requestEditorReconnect: () =>
      set((state) => ({
        editorNeedsReconnect: false,
        editorReconnectSignal: state.editorReconnectSignal + 1,
      })),

    refreshRuntimeStatus: async () => {
      try {
        const runtimeStatus = await getRuntimeStatus();
        set((state) => {
          const nextState = {
            runtimeStatus,
            runtimeStatusError: null,
            comfyuiDirectUrl: runtimeStatus.comfyui.url,
            connectionStatus: connectionStatusFromRuntime(runtimeStatus),
          } as import("./types").GenerationStorePatch;

          if (
            runtimeStatus.comfyui.status !== "connected" &&
            state.isWorkflowLoading
          ) {
            nextState.isWorkflowLoading = false;
            nextState.workflowLoadState = state.syncedWorkflow ? "ready" : "error";
            nextState.isWorkflowReady = state.syncedWorkflow !== null;
            nextState.workflowLoadError =
              runtimeStatus.comfyui.error ??
              "ComfyUI is unavailable. Start it and retry loading inputs.";
          }

          if (
            runtimeStatus.comfyui.status === "connected" &&
            state.connectionStatus !== "connected"
          ) {
            get().requestEditorReconnect();
          }

          return nextState;
        });
        return runtimeStatus;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Backend status check failed";
        set((state) => ({
          runtimeStatus: null,
          runtimeStatusError: message,
          connectionStatus: "error",
          ...(state.isWorkflowLoading
            ? {
                isWorkflowLoading: false,
                workflowLoadState: state.syncedWorkflow ? "ready" : "error",
                isWorkflowReady: state.syncedWorkflow !== null,
                workflowLoadError: message,
              }
            : {}),
        }));
        return null;
      }
    },

    syncObjectInfo: async () => {
      if (get().connectionStatus !== "connected") return;
      try {
        console.info("[Generation] Syncing object_info from ComfyUI...");
        const result = await comfyApi.syncObjectInfo();
        const inputNodeMap = mergeInputNodeMap(result.input_node_map);
        set({ objectInfoSynced: true, inputNodeMap });
      } catch (err) {
        console.error("[Generation] Failed to sync object_info:", err);
      }
    },

    connect: () => {
      const existing = get().wsClient;
      if (existing) {
        void get().refreshRuntimeStatus();
        if (!existing.isConnected) {
          set({ connectionStatus: "connecting" });
          existing.connect();
        }
        return;
      }

      set({ connectionStatus: "connecting" });
      void get().refreshRuntimeStatus();

      const client = new ComfyUIWebSocket(API_BASE_URL);

      const runJobPostprocess = async (
        jobSnapshot: import("../types").GenerationJob,
      ) => {
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
              ...(nextPreviewFrames
                ? { jobPreviewFrames: nextPreviewFrames }
                : {}),
              ...(state.pipelineStatus.phase === "postprocessing"
                ? { pipelineStatus: IDLE_PIPELINE_STATUS }
                : {}),
            };
          });
        }
      };

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

      client.connect();
      set({ wsClient: client });

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

      void get().fetchWorkflows();
    },

    disconnect: () => {
      const {
        wsClient,
        latestPreviewUrl,
        previewAnimation,
        jobs,
        preprocessAbortController,
        pipelineRunToken,
      } = get();
      preprocessAbortController?.abort();
      wsClient?.disconnect();
      if (latestPreviewUrl) URL.revokeObjectURL(latestPreviewUrl);
      revokePreviewAnimation(previewAnimation);
      for (const job of jobs.values()) {
        revokeJobPostprocessPreview(job);
      }
      set({
        wsClient: null,
        connectionStatus: "disconnected",
        runtimeStatus: null,
        runtimeStatusError: null,
        latestPreviewUrl: null,
        previewAnimation: null,
        jobPreviewFrames: new Map(),
        editorNeedsReconnect: false,
        pipelineStatus: IDLE_PIPELINE_STATUS,
        preprocessAbortController: null,
        pipelineRunToken: pipelineRunToken + 1,
        objectInfoSynced: false,
      });
    },

    updateComfyUrl: async (url: string) => {
      await comfyApi.updateConfig(url);
      get().disconnect();
      const runtimeStatus = await get().refreshRuntimeStatus();
      set((state) => ({
        comfyuiDirectUrl: runtimeStatus?.comfyui.url ?? url,
        editorNeedsReconnect: false,
        ...(runtimeStatus
          ? {
              runtimeStatus,
              runtimeStatusError: null,
              connectionStatus: connectionStatusFromRuntime(runtimeStatus),
            }
          : {
              runtimeStatus: state.runtimeStatus,
              runtimeStatusError: state.runtimeStatusError,
              connectionStatus: state.connectionStatus,
            }),
      }));
      get().connect();
    },
  };
}
