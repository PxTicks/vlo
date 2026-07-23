import { create } from "zustand";
import {
  approveExtensionDigest,
  declineExtensionDigest,
  disableExtension,
  fetchExtensionInventory,
  revokeExtensionApproval,
} from "../services/extensionManagementApi";
import type { ExtensionInventoryItem } from "../services/extensionManagementApi";

export type ExtensionInventoryLoadStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export type ExtensionManagementAction =
  | "approve"
  | "decline"
  | "disable"
  | "revoke";

export interface ExtensionManagementMutation {
  extensionId: string;
  action: ExtensionManagementAction;
}

interface ExtensionManagementState {
  items: ExtensionInventoryItem[];
  loadStatus: ExtensionInventoryLoadStatus;
  error: string | null;
  mutation: ExtensionManagementMutation | null;
  load(): Promise<void>;
  approve(extensionId: string, digest: string): Promise<boolean>;
  decline(extensionId: string, digest: string): Promise<boolean>;
  disable(extensionId: string): Promise<boolean>;
  revoke(extensionId: string): Promise<boolean>;
  cancelPending(): void;
}

let loadRequestId = 0;
let loadAbortController: AbortController | null = null;
let mutationRequestId = 0;
let mutationAbortController: AbortController | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The extension manager request failed.";
}

function replaceInventoryItem(
  items: ExtensionInventoryItem[],
  replacement: ExtensionInventoryItem,
): ExtensionInventoryItem[] {
  return items.map((item) =>
    item.id === replacement.id ? replacement : item,
  );
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export const useExtensionManagementStore = create<ExtensionManagementState>(
  (set, get) => {
    const runMutation = async (
      extensionId: string,
      action: ExtensionManagementAction,
      request: (signal: AbortSignal) => Promise<ExtensionInventoryItem>,
    ): Promise<boolean> => {
      // Mutations are deliberately serialized until the backend has explicit
      // per-extension concurrency and idempotency guarantees.
      if (get().mutation !== null) return false;

      const requestId = ++mutationRequestId;
      const controller = new AbortController();
      mutationAbortController = controller;
      set({ mutation: { extensionId, action }, error: null });
      try {
        const item = await request(controller.signal);
        if (requestId !== mutationRequestId) return false;

        mutationAbortController = null;
        set((state) => ({
          items: replaceInventoryItem(state.items, item),
          mutation: null,
        }));
        return true;
      } catch (error) {
        if (requestId !== mutationRequestId) return false;

        mutationAbortController = null;
        set({
          mutation: null,
          error: isAbortError(error) ? null : errorMessage(error),
        });
        return false;
      }
    };

    return {
      items: [],
      loadStatus: "idle",
      error: null,
      mutation: null,

      load: async () => {
        loadAbortController?.abort();
        const requestId = ++loadRequestId;
        const controller = new AbortController();
        loadAbortController = controller;
        set({ loadStatus: "loading", error: null });
        try {
          const items = await fetchExtensionInventory({
            signal: controller.signal,
          });
          if (requestId !== loadRequestId) return;

          loadAbortController = null;
          set({ items, loadStatus: "ready", error: null });
        } catch (error) {
          if (requestId !== loadRequestId) return;

          loadAbortController = null;
          if (isAbortError(error)) {
            set({
              loadStatus: get().items.length > 0 ? "ready" : "idle",
              error: null,
            });
            return;
          }
          set({ loadStatus: "error", error: errorMessage(error) });
        }
      },

      approve: (extensionId, digest) =>
        runMutation(extensionId, "approve", (signal) =>
          approveExtensionDigest(extensionId, digest, { signal }),
        ),

      decline: (extensionId, digest) =>
        runMutation(extensionId, "decline", (signal) =>
          declineExtensionDigest(extensionId, digest, { signal }),
        ),

      disable: (extensionId) =>
        runMutation(extensionId, "disable", (signal) =>
          disableExtension(extensionId, { signal }),
        ),

      revoke: (extensionId) =>
        runMutation(extensionId, "revoke", (signal) =>
          revokeExtensionApproval(extensionId, { signal }),
        ),

      cancelPending: () => {
        const hadPendingRequest =
          loadAbortController !== null || mutationAbortController !== null;
        loadRequestId += 1;
        mutationRequestId += 1;
        loadAbortController?.abort();
        mutationAbortController?.abort();
        loadAbortController = null;
        mutationAbortController = null;
        set((state) => ({
          loadStatus:
            state.items.length > 0 ? "ready" : "idle",
          mutation: null,
          error: hadPendingRequest ? null : state.error,
        }));
      },
    };
  },
);
