import { create } from "zustand";
import {
  getRuntimeCapabilities,
  getRuntimeCapability,
  getRuntimeCapabilityProbe,
  startRuntimeCapabilityProbe,
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

/**
 * How an operation on one capability ended.
 *
 * The store keeps reporting failure through `error` for the panels that render
 * it, but a caller that asked for the work needs the answer too: a failed
 * recheck leaves the previous snapshot in place, so "did it work" is not
 * recoverable from the store afterwards. `cancelled` is not a failure — the
 * user or a deactivating owner stopped waiting.
 */
export interface CapabilityOperationOutcome {
  status: "succeeded" | "failed" | "cancelled";
  error: string | null;
}

const SUCCEEDED: CapabilityOperationOutcome = Object.freeze({
  status: "succeeded" as const,
  error: null,
});

const CANCELLED: CapabilityOperationOutcome = Object.freeze({
  status: "cancelled" as const,
  error: null,
});

export interface RuntimeCapabilityStoreState {
  status: RuntimeCapabilityFetchStatus;
  capabilities: Record<string, RuntimeCapability>;
  /** Carries its own `checkedAt`; each capability carries its own too. */
  environment: RuntimeEnvironmentSnapshot | null;
  error: string | null;
  /** Ids with a recheck in flight, so a card can spin without blanking. */
  refreshing: string[];
  /** Ids with an explicit model-load job queued or running. */
  testing: string[];
  /** Fetch once. Concurrent callers join the in-flight request. */
  ensureLoaded: () => Promise<void>;
  /** Drop the backend's probe cache and re-run every check. */
  refreshAll: () => Promise<void>;
  /** Re-run one capability's checks. Concurrent callers join the same run. */
  refreshCapability: (capabilityId: string) => Promise<CapabilityOperationOutcome>;
  /** Queue and follow an explicit runtime load test. Callers join one run. */
  testCapability: (capabilityId: string) => Promise<CapabilityOperationOutcome>;
  /**
   * Stop following one capability's load test, without cancelling the backend
   * job. For an owner going away — a deactivating extension — while other
   * tests keep running.
   */
  cancelTest: (capabilityId: string) => void;
  /** Stop client-side probe polling without cancelling the backend job. */
  cancelTests: () => void;
  /**
   * Re-read what the backend knows, without asking it to re-probe.
   *
   * For when something happened that the registry has already recorded — a
   * real load failure, say. A refresh would be wrong here: it would discard
   * the very failure we want to pick up.
   */
  reload: () => Promise<void>;
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

const MAX_PROBE_POLLS = 2_400;

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(
        new DOMException("Runtime probe polling was cancelled", "AbortError"),
      );
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 500);
    function abort() {
      globalThis.clearTimeout(timer);
      reject(
        new DOMException("Runtime probe polling was cancelled", "AbortError"),
      );
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export const useRuntimeCapabilityStore = create<RuntimeCapabilityStoreState>(
  (set, get) => {
    // Module-local singletons rather than store state: neither is rendered,
    // and keeping the promise out of the store means a second caller joins the
    // same request instead of racing a status flag.
    let inFlightLoad: Promise<void> | null = null;
    // The same, per capability, for the two operations that target one: a
    // second caller joins the work rather than being told nothing happened.
    const refreshes = new Map<string, Promise<CapabilityOperationOutcome>>();
    const tests = new Map<string, Promise<CapabilityOperationOutcome>>();

    // Every fetch that mutates the store runs through this chain. A full
    // refresh and a per-card recheck both invalidate the backend's shared
    // probe cache, so overlapping them would have each re-run the other's
    // probes and land results in whichever order they finished.
    let queue: Promise<unknown> = Promise.resolve();
    let probeGeneration = 0;
    const probeControllers = new Map<string, AbortController>();

    function cancelProbePolling() {
      probeGeneration += 1;
      for (const controller of probeControllers.values()) {
        controller.abort();
      }
      probeControllers.clear();
    }

    function serialize<T>(task: () => Promise<T>): Promise<T> {
      const next = queue.then(task, task);
      queue = next.catch(() => undefined);
      return next;
    }

    /**
     * One runtime load test, start to terminal state.
     *
     * Split out of the store action so the action itself is only the join: a
     * second caller for the same capability gets this promise rather than
     * returning immediately, which used to hand back "nothing happened" while
     * the first test was still running.
     */
    async function runTest(
      capabilityId: string,
    ): Promise<CapabilityOperationOutcome> {
      const controller = new AbortController();
      const generation = probeGeneration;
      probeControllers.set(capabilityId, controller);
      const cancelled = () =>
        controller.signal.aborted || generation !== probeGeneration;
      set((state) => ({
        testing: [...state.testing, capabilityId],
        error: null,
      }));
      try {
        const requestOptions = { signal: controller.signal };
        const { jobId } = await startRuntimeCapabilityProbe(
          capabilityId,
          requestOptions,
        );
        if (cancelled()) return CANCELLED;
        let job = await getRuntimeCapabilityProbe(
          capabilityId,
          jobId,
          requestOptions,
        );
        let polls = 0;
        while (job.status === "queued" || job.status === "running") {
          if (polls >= MAX_PROBE_POLLS) {
            throw new Error("Runtime load test did not finish within 20 minutes");
          }
          polls += 1;
          await waitForPoll(controller.signal);
          job = await getRuntimeCapabilityProbe(
            capabilityId,
            jobId,
            requestOptions,
          );
        }
        if (cancelled()) return CANCELLED;

        // Success and failure both update the registry. Read that evidence
        // before surfacing the terminal job message so the card and alert
        // cannot disagree.
        const payload = await serialize(() =>
          getRuntimeCapability(capabilityId, requestOptions),
        );
        if (cancelled()) return CANCELLED;
        const failure =
          job.status === "succeeded"
            ? null
            : job.error ?? `${payload.capability.label} load test failed`;
        set((state) => ({
          status: "ready",
          capabilities: {
            ...state.capabilities,
            [payload.capability.id]: payload.capability,
          },
          environment: payload.environment,
          error: failure,
        }));
        return failure === null
          ? SUCCEEDED
          : { status: "failed", error: failure };
      } catch (error) {
        if (cancelled() || isAbortError(error)) return CANCELLED;
        const message = messageFor(error, `Failed to test ${capabilityId}`);
        set({ error: message });
        return { status: "failed", error: message };
      } finally {
        if (probeControllers.get(capabilityId) === controller) {
          probeControllers.delete(capabilityId);
        }
        if (generation === probeGeneration) {
          set((state) => ({
            testing: state.testing.filter((id) => id !== capabilityId),
          }));
        }
      }
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
      testing: [],

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

      reload: async () => {
        // Unlike ensureLoaded, this request is ordered *after* any read already
        // in flight: it is asking for evidence a just-failed job recorded. If
        // we merely joined an older read, its response could predate the
        // failure and leave the UI claiming the runtime is still available.
        if (inFlightLoad) await inFlightLoad;
        if (inFlightLoad) return inFlightLoad;
        set({ status: "checking", error: null });
        inFlightLoad = serialize(() => load(false)).finally(() => {
          inFlightLoad = null;
        });
        return inFlightLoad;
      },

      refreshCapability: async (capabilityId) => {
        const inFlight = refreshes.get(capabilityId);
        if (inFlight) return inFlight;
        set((state) => ({ refreshing: [...state.refreshing, capabilityId] }));
        const running = serialize(async (): Promise<CapabilityOperationOutcome> => {
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
            return SUCCEEDED;
          } catch (error) {
            const message = messageFor(
              error,
              `Failed to recheck ${capabilityId}`,
            );
            set({ error: message });
            return { status: "failed", error: message };
          } finally {
            set((state) => ({
              refreshing: state.refreshing.filter((id) => id !== capabilityId),
            }));
          }
        }).finally(() => {
          if (refreshes.get(capabilityId) === running) {
            refreshes.delete(capabilityId);
          }
        });
        refreshes.set(capabilityId, running);
        return running;
      },

      testCapability: async (capabilityId) => {
        const inFlight = tests.get(capabilityId);
        if (inFlight) return inFlight;
        const running = runTest(capabilityId).finally(() => {
          if (tests.get(capabilityId) === running) tests.delete(capabilityId);
        });
        tests.set(capabilityId, running);
        return running;
      },

      cancelTest: (capabilityId) => {
        const controller = probeControllers.get(capabilityId);
        if (controller === undefined) return;
        controller.abort();
        probeControllers.delete(capabilityId);
        set((state) => ({
          testing: state.testing.filter((id) => id !== capabilityId),
        }));
      },

      cancelTests: () => {
        cancelProbePolling();
        set({ testing: [] });
      },

      reset: () => {
        cancelProbePolling();
        inFlightLoad = null;
        refreshes.clear();
        tests.clear();
        queue = Promise.resolve();
        set({
          status: "idle",
          capabilities: {},
          environment: null,
          error: null,
          refreshing: [],
          testing: [],
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
