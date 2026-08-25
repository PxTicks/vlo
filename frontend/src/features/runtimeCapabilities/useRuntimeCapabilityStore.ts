import { create } from "zustand";
import {
  getRuntimeCapabilities,
  getRuntimeCapability,
} from "../../services/runtimeApi";
import type {
  RuntimeCapability,
  RuntimeEnvironmentSnapshot,
} from "../../types/RuntimeStatus";

/**
 * Whether the store has an answer yet — distinct from what the answer is.
 *
 * `checking` matters: a cold request runs out-of-process import probes and
 * can take upwards of ten seconds, so every surface needs to say "still
 * looking" rather than "unavailable" while the first request is in flight.
 */
export type RuntimeCapabilityFetchStatus =
  | "idle"
  | "checking"
  | "ready"
  | "error";

export interface RuntimeCapabilityStoreState {
  status: RuntimeCapabilityFetchStatus;
  capabilities: Record<string, RuntimeCapability>;
  /** Carries its own `checkedAt`; each capability carries its own too. */
  environment: RuntimeEnvironmentSnapshot | null;
  error: string | null;
  /** Ids with a recheck in flight, so a card can spin without blanking. */
  refreshing: string[];
  /** Fetch once. Concurrent callers join the in-flight request. */
  ensureLoaded: () => Promise<void>;
  /** Drop the backend's probe cache and re-run every check. */
  refreshAll: () => Promise<void>;
  /** Re-run one capability's checks. */
  refreshCapability: (capabilityId: string) => Promise<void>;
  reset: () => void;
}

function indexById(
  capabilities: RuntimeCapability[],
): Record<string, RuntimeCapability> {
  return Object.fromEntries(
    capabilities.map((capability) => [capability.id, capability]),
  );
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const useRuntimeCapabilityStore = create<RuntimeCapabilityStoreState>(
  (set, get) => {
    // Module-local singletons rather than store state: neither is rendered,
    // and keeping the promise out of the store means a second caller joins the
    // same request instead of racing a status flag.
    let inFlightLoad: Promise<void> | null = null;

    // Every fetch that mutates the store runs through this chain. A full
    // refresh and a per-card recheck both invalidate the backend's shared
    // probe cache, so overlapping them would have each re-run the other's
    // probes and land results in whichever order they finished.
    let queue: Promise<unknown> = Promise.resolve();

    function serialize<T>(task: () => Promise<T>): Promise<T> {
      const next = queue.then(task, task);
      queue = next.catch(() => undefined);
      return next;
    }

    async function load(refresh: boolean): Promise<void> {
      try {
        const payload = await getRuntimeCapabilities({ refresh });
        set({
          status: "ready",
          capabilities: indexById(payload.capabilities),
          environment: payload.environment,
          error: null,
        });
      } catch (error) {
        set({
          status: "error",
          error: messageFor(error, "Failed to read runtime capabilities"),
        });
      }
    }

    return {
      status: "idle",
      capabilities: {},
      environment: null,
      error: null,
      refreshing: [],

      ensureLoaded: async () => {
        const { status } = get();
        if (status === "ready") return;
        if (inFlightLoad) return inFlightLoad;
        // Marked synchronously: the request may sit behind a recheck in the
        // queue, and a caller that renders on the next line must not see
        // "idle" and conclude nothing is happening.
        set({ status: "checking", error: null });
        inFlightLoad = serialize(() => load(false)).finally(() => {
          inFlightLoad = null;
        });
        return inFlightLoad;
      },

      refreshAll: async () => {
        if (inFlightLoad) return inFlightLoad;
        set({ status: "checking", error: null });
        inFlightLoad = serialize(() => load(true)).finally(() => {
          inFlightLoad = null;
        });
        return inFlightLoad;
      },

      refreshCapability: async (capabilityId) => {
        if (get().refreshing.includes(capabilityId)) return;
        set((state) => ({ refreshing: [...state.refreshing, capabilityId] }));
        await serialize(async () => {
          try {
            const payload = await getRuntimeCapability(capabilityId, {
              refresh: true,
            });
            set((state) => ({
              status: "ready",
              capabilities: {
                ...state.capabilities,
                [payload.capability.id]: payload.capability,
              },
              // The recheck dropped the shared device probe, so the snapshot
              // that came back with it is the current one.
              environment: payload.environment,
              error: null,
            }));
          } catch (error) {
            set({
              error: messageFor(error, `Failed to recheck ${capabilityId}`),
            });
          } finally {
            set((state) => ({
              refreshing: state.refreshing.filter((id) => id !== capabilityId),
            }));
          }
        });
      },

      reset: () => {
        inFlightLoad = null;
        queue = Promise.resolve();
        set({
          status: "idle",
          capabilities: {},
          environment: null,
          error: null,
          refreshing: [],
        });
      },
    };
  },
);

export function selectCapability(
  state: RuntimeCapabilityStoreState,
  capabilityId: string,
): RuntimeCapability | null {
  return state.capabilities[capabilityId] ?? null;
}
