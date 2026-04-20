import { API_BASE_URL } from "../../../config";
import { getRuntimeStatus } from "../../../services/runtimeApi";
import { ComfyUIWebSocket } from "../services/ComfyUIWebSocket";
import { GenerationDeliveryWebSocket } from "../services/GenerationDeliveryWebSocket";
import * as comfyApi from "../services/comfyuiApi";
import { mergeInputNodeMap } from "../constants/inputNodeMap";
import { IDLE_PIPELINE_STATUS } from "./constants";
import { revokeJobPostprocessPreview, revokePreviewAnimation } from "./previewState";
import { attachDeliveryClientHandlers } from "./deliveryEvents";
import { attachRuntimeClientHandlers } from "./runtimeEvents";
import { useProjectStore } from "../../project";
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
  function createDeliveryClient(projectId: string): GenerationDeliveryWebSocket {
    const deliveryClient = new GenerationDeliveryWebSocket(API_BASE_URL, projectId);
    attachDeliveryClientHandlers(deliveryClient, set, get);
    deliveryClient.connect();
    set({
      deliveryClient,
      deliveryConnectionStatus: "connecting",
    });
    return deliveryClient;
  }

  return {
    connectionStatus: "disconnected",
    runtimeStatus: null,
    runtimeStatusError: null,
    comfyuiDirectUrl: null,
    wsClient: null,
    deliveryClient: null,
    deliveryConnectionStatus: "disconnected",
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
        let shouldReconnectEditor = false;
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
            shouldReconnectEditor = state.editorNeedsReconnect;
          }

          return nextState;
        });
        if (shouldReconnectEditor) {
          get().requestEditorReconnect();
        }
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
      const existingDelivery = get().deliveryClient;
      const projectId = useProjectStore.getState().project?.id ?? null;
      if (existing) {
        void get().refreshRuntimeStatus();
        if (!existing.isConnected) {
          set({ connectionStatus: "connecting" });
          existing.connect();
        }
        if (!projectId) {
          if (existingDelivery) {
            existingDelivery.disconnect();
            set({
              deliveryClient: null,
              deliveryConnectionStatus: "disconnected",
            });
          }
          return;
        }
        if (!existingDelivery) {
          createDeliveryClient(projectId);
          return;
        }
        if (!existingDelivery.isConnected) {
          set({ deliveryConnectionStatus: "connecting" });
          existingDelivery.connect();
        }
        return;
      }

      set({ connectionStatus: "connecting" });
      void get().refreshRuntimeStatus();

      const client = new ComfyUIWebSocket(API_BASE_URL);
      attachRuntimeClientHandlers(client, set, get);

      client.connect();
      if (!projectId) {
        set({ wsClient: client });
        void get().fetchWorkflows();
        return;
      }

      set({
        wsClient: client,
      });
      createDeliveryClient(projectId);
      void get().fetchWorkflows();
    },

    disconnect: () => {
      const {
        wsClient,
        deliveryClient,
        latestPreviewUrl,
        previewAnimation,
        jobs,
        preprocessAbortController,
        pipelineRunToken,
      } = get();
      preprocessAbortController?.abort();
      wsClient?.disconnect();
      deliveryClient?.disconnect();
      if (latestPreviewUrl) URL.revokeObjectURL(latestPreviewUrl);
      revokePreviewAnimation(previewAnimation);
      for (const job of jobs.values()) {
        revokeJobPostprocessPreview(job);
      }
      set({
        wsClient: null,
        deliveryClient: null,
        connectionStatus: "disconnected",
        deliveryConnectionStatus: "disconnected",
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
