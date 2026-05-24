import { API_BASE_URL } from "../../../config";
import { getRuntimeStatus } from "../../../services/runtimeApi";
import { ComfyUIWebSocket } from "../services/ComfyUIWebSocket";
import { GenerationDeliveryWebSocket } from "../services/GenerationDeliveryWebSocket";
import * as comfyApi from "../services/comfyuiApi";
import { mergeInputNodeMap } from "../constants/inputNodeMap";
import { IDLE_PIPELINE_STATUS, TEMP_WORKFLOW_ID } from "./constants";
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
  // Module-local promise singleton: dedupe concurrent syncObjectInfo calls
  // so a parallel `fetchWorkflows` race (initial connect + WS "status" event)
  // doesn't fire two backend sync requests. Cleared on settle.
  let inFlightSyncPromise: Promise<void> | null = null;

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
    rawObjectInfo: null,
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
            nextState.workflowLoadState = state.syncedGraphData ? "ready" : "error";
            nextState.isWorkflowReady = state.syncedGraphData !== null;
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
                workflowLoadState: state.syncedGraphData ? "ready" : "error",
                isWorkflowReady: state.syncedGraphData !== null,
                workflowLoadError: message,
              }
            : {}),
        }));
        return null;
      }
    },

    syncObjectInfo: async () => {
      // Skip only when ComfyUI is definitely unreachable. Allow "connecting"
      // so the very first fetchWorkflows (fired before the WS "status" event
      // flips the store to "connected") can still populate the cache: the
      // backend will return 503 if it genuinely can't reach ComfyUI, and we
      // leave objectInfoSynced=false so the next trigger retries.
      const status = get().connectionStatus;
      if (status === "disconnected" || status === "error") return;

      if (inFlightSyncPromise) return inFlightSyncPromise;

      const hadObjectInfo = get().rawObjectInfo !== null;
      inFlightSyncPromise = (async () => {
        try {
          console.info("[Generation] Syncing object_info from ComfyUI...");
          const result = await comfyApi.syncObjectInfo();
          const inputNodeMap = mergeInputNodeMap(result.input_node_map);
          set({
            objectInfoSynced: true,
            rawObjectInfo: result.object_info ?? null,
            inputNodeMap,
          });

          // The first workflow load can race ahead of object_info on a cold
          // start, leaving the backend's enrich pass to run against an empty
          // cache and the panel rendering without auto-discovered widgets, AR
          // targets, or default validation. Re-resolve the active workflow now
          // that object_info is populated so its rules pick up enrichment.
          if (!hadObjectInfo) {
            const { selectedWorkflowId, loadWorkflow } = get();
            if (
              selectedWorkflowId &&
              selectedWorkflowId !== TEMP_WORKFLOW_ID
            ) {
              void loadWorkflow(selectedWorkflowId);
            }
          }
        } catch (err) {
          console.error("[Generation] Failed to sync object_info:", err);
        } finally {
          inFlightSyncPromise = null;
        }
      })();

      return inFlightSyncPromise;
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
        rawObjectInfo: null,
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
