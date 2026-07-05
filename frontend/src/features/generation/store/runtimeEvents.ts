import type {
  ComfyUIEvent,
  ComfyUIWebSocket,
} from "../services/ComfyUIWebSocket";
import { markActiveJobError } from "./jobMutations";
import type { GenerationStoreGet, GenerationStoreSet } from "./types";

/**
 * Attach handlers for the ComfyUI status websocket.
 *
 * This channel is a connection-health/status feed only. Per-job lifecycle
 * events (progress, executed, success, error) are unicast by ComfyUI to the
 * submitting client_id — which is the backend delivery monitor — and reach
 * the frontend through the generation delivery websocket (`deliveryEvents`).
 */
export function attachRuntimeClientHandlers(
  client: ComfyUIWebSocket,
  set: GenerationStoreSet,
  get: GenerationStoreGet,
): void {
  function resumeQueuedDispatch(): void {
    void get().processGenerationQueue();
  }

  client.onEvent((event: ComfyUIEvent) => {
    switch (event.type) {
      case "status": {
        // ComfyUI broadcasts its global queue depth (running + pending across
        // all clients) on every queue change. Tracking it makes vlo aware that
        // the editor iframe — or another client — is also using ComfyUI.
        const queueRemaining = event.data.status?.exec_info?.queue_remaining;
        if (typeof queueRemaining === "number") {
          set({ comfyQueueRemaining: queueRemaining });
        }
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

  client.onConnectionChange((wsState) => {
    if (wsState === "connected") {
      void get().refreshRuntimeStatus();
      if (get().connectionStatus !== "connected") {
        set({ connectionStatus: "connecting" });
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
