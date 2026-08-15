import { create } from "zustand";
import { postHostToast } from "../../core/shell/notificationCenter";
import {
  fetchModelWorkSnapshot,
  releaseModelWorkEntry,
  type ModelWorkEntry,
  type ModelWorkEvent,
  type ModelWorkResourceView,
  type ModelWorkSnapshot,
  type ModelWorkSource,
} from "./services/modelWorkApi";
import {
  ModelWorkWebSocket,
  type ModelWorkConnectionState,
} from "./services/ModelWorkWebSocket";

const LOCAL_GPU_RESOURCE = "local-gpu";

const SOURCE_LABELS: Record<ModelWorkSource, string> = {
  beats: "Beat This!",
  sam2: "SAM2",
  "sam-audio": "SAM-Audio",
  "comfyui-vlo": "ComfyUI",
  "comfyui-iframe": "ComfyUI (in-editor)",
  extension: "Extension",
};

export interface ModelWorkState {
  ready: boolean;
  revision: number;
  connection: ModelWorkConnectionState | "connecting";
  entries: ModelWorkEntry[];
  resources: ModelWorkResourceView[];
  error: string | null;
  connect: () => void;
  disconnect: () => void;
  refresh: () => Promise<void>;
  releaseEntry: (entryId: string) => Promise<void>;
}

let socket: ModelWorkWebSocket | null = null;
let unsubscribers: Array<() => void> = [];
let refreshToken = 0;
// The ledger has more than one consumer (the Queue panel, and the generation
// queue's admission gate), so the socket is reference counted rather than owned
// by whichever component mounted first.
let connectionCount = 0;

function applySnapshot(snapshot: ModelWorkSnapshot): Partial<ModelWorkState> {
  return {
    ready: snapshot.ready,
    revision: snapshot.revision,
    entries: [...snapshot.entries],
    resources: [...snapshot.resources],
    error: null,
  };
}

/**
 * Invalidate any HTTP refresh still in flight.
 *
 * Socket messages are authoritative — the snapshot they carry was captured
 * under the coordinator's lock. A slower `GET` that started earlier would
 * otherwise land afterwards and roll state back to an older revision, which
 * repeats indefinitely under load.
 */
function invalidatePendingRefresh(): void {
  refreshToken += 1;
}

function applyEvent(state: ModelWorkState, event: ModelWorkEvent): ModelWorkState {
  const entries = state.entries.filter(
    (entry) => entry.entryId !== event.entry.entryId,
  );
  if (event.kind !== "removed") {
    entries.push(event.entry);
  }
  entries.sort((left, right) => left.submittedAt - right.submittedAt);
  return {
    ...state,
    revision: event.revision,
    entries,
    resources: [...event.resources],
  };
}

export const useModelWorkStore = create<ModelWorkState>((set, get) => ({
  ready: false,
  revision: 0,
  connection: "connecting",
  entries: [],
  resources: [],
  error: null,

  connect: () => {
    connectionCount += 1;
    if (socket) {
      socket.connect();
      return;
    }
    socket = new ModelWorkWebSocket();
    unsubscribers = [
      socket.onMessage((message) => {
        invalidatePendingRefresh();
        if (message.type === "snapshot") {
          // Always authoritative, including after a backend restart, where the
          // coordinator's revision counter legitimately goes backwards.
          set(applySnapshot(message.data));
          return;
        }
        const state = get();
        if (message.data.revision !== state.revision + 1) {
          // A gap means an event was dropped somewhere between the coordinator
          // and here. The revision is the only thing that can tell us, so
          // re-snapshot rather than render a ledger we know is wrong.
          void get().refresh();
          return;
        }
        notifyTerminalFailure(state, message.data);
        set(applyEvent(state, message.data));
      }),
      socket.onConnectionChange((connection) => {
        set({ connection });
        if (connection === "connected") {
          void get().refresh();
        }
      }),
    ];
    socket.connect();
    void get().refresh();
  },

  disconnect: () => {
    connectionCount = Math.max(0, connectionCount - 1);
    if (connectionCount > 0) {
      return;
    }
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    unsubscribers = [];
    socket?.disconnect();
    socket = null;
    set({ connection: "disconnected" });
  },

  refresh: async () => {
    const token = ++refreshToken;
    try {
      const snapshot = await fetchModelWorkSnapshot();
      // Superseded by a newer refresh, or by a socket message that arrived
      // while this one was in flight.
      if (token !== refreshToken) return;
      // ...and even an uncontested response can be older than what the socket
      // already delivered, since the two race independently.
      if (snapshot.revision < get().revision) return;
      set(applySnapshot(snapshot));
    } catch (error) {
      if (token !== refreshToken) return;
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  releaseEntry: async (entryId: string) => {
    await releaseModelWorkEntry(entryId);
    await get().refresh();
  },
}));

function notifyTerminalFailure(state: ModelWorkState, event: ModelWorkEvent): void {
  if (event.kind === "removed" || event.entry.jobStatus !== "failed") {
    return;
  }
  const previous = state.entries.find(
    (entry) => entry.entryId === event.entry.entryId,
  );
  if (previous?.jobStatus === "failed") {
    return;
  }
  postHostToast(
    `${sourceLabel(event.entry.source)}: ${event.entry.message ?? event.entry.label} failed`,
    "error",
  );
}

export function sourceLabel(source: ModelWorkSource): string {
  return SOURCE_LABELS[source] ?? source;
}

export function isActiveEntry(entry: ModelWorkEntry): boolean {
  return entry.occupancy !== "released";
}

/** Entries still holding or waiting for a resource, oldest first. */
export function selectActiveEntries(state: ModelWorkState): ModelWorkEntry[] {
  return state.entries.filter(isActiveEntry);
}

export function selectHistoryEntries(state: ModelWorkState): ModelWorkEntry[] {
  return state.entries.filter((entry) => !isActiveEntry(entry)).reverse();
}

export function selectGpuTenant(state: ModelWorkState): string | null {
  const gpu = state.resources.find(
    (view) => view.resource === LOCAL_GPU_RESOURCE && view.holderCount > 0,
  );
  return gpu?.tenant ?? null;
}

/**
 * Whether the shared GPU is occupied by anyone. Cross-feature awareness only:
 * a feature's own button still owns its optimistic in-flight state, because the
 * ledger round-trip is slower than a click.
 */
export function selectIsGpuBusy(state: ModelWorkState): boolean {
  return selectGpuTenant(state) !== null;
}

/**
 * Whether vlo's own in-process models hold the GPU. This — not
 * {@link selectIsGpuBusy} — is what gates dispatching a ComfyUI prompt: prompts
 * already under the ComfyUI tenant share one occupancy and queue normally
 * inside ComfyUI.
 */
export function selectIsLocalModelWorkHoldingGpu(state: ModelWorkState): boolean {
  return selectGpuTenant(state) === "backend-process";
}

/** Whether a specific source currently holds or waits for the GPU. */
export function selectIsSourceBusy(
  state: ModelWorkState,
  source: ModelWorkSource,
): boolean {
  return state.entries.some(
    (entry) => entry.source === source && isActiveEntry(entry),
  );
}
