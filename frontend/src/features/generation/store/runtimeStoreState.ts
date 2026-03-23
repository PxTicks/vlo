import { API_BASE_URL } from "../../../config";
import { getRuntimeStatus } from "../../../services/runtimeApi";
import { ComfyUIWebSocket } from "../services/ComfyUIWebSocket";
import * as comfyApi from "../services/comfyuiApi";
import { mergeInputNodeMap } from "../constants/inputNodeMap";
import { IDLE_PIPELINE_STATUS } from "./constants";
import { revokeJobPostprocessPreview, revokePreviewAnimation } from "./previewState";
import { attachRuntimeClientHandlers } from "./runtimeEvents";
import type {
  ComfyUIConnectionStatus,
  GenerationRuntimeState,
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

export function buildRuntimeStoreState(
  set: GenerationStoreSet,
  get: GenerationStoreGet,
): GenerationRuntimeState {
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
      attachRuntimeClientHandlers(client, set, get);

      client.connect();
      set({ wsClient: client });
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
