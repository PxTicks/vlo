import { create } from "zustand";
import {
  cancelRuntimeCapabilityInstall,
  getRuntimeCapabilities,
  getRuntimeCapability,
  getRuntimeCapabilityInstall,
  getRuntimeCapabilityProbe,
  startRuntimeCapabilityInstall,
  startRuntimeCapabilityProbe,
} from "../../services/runtimeApi";
import type {
  RuntimeCapability,
  RuntimeEnvironmentSnapshot,
} from "../../types/RuntimeStatus";
import { useBackendRestartStore } from "./useBackendRestartStore";

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

/**
 * An install, as the surface that started it needs to see it.
 *
 * The log is kept because it is the only honest progress an install has, and
 * because a failed install is unreadable without it — "exited with status 1"
 * is not a reason. It survives the job finishing so the user can still read
 * what happened.
 */
export interface CapabilityInstallProgress {
  jobId: string | null;
  status: "starting" | "running" | "succeeded" | "failed" | "cancelled";
  message: string;
  log: string[];
  error: string | null;
}

/** Longest install log kept per capability. The backend caps its own at 100. */
const MAX_INSTALL_LOG_LINES = 200;

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
  /** Ids with an install job queued or running. */
  installing: string[];
  /** The last install attempt per capability, running or finished. */
  installs: Record<string, CapabilityInstallProgress>;
  /** Fetch once. Concurrent callers join the in-flight request. */
  ensureLoaded: () => Promise<void>;
  /** Drop the backend's probe cache and re-run every check. */
  refreshAll: () => Promise<void>;
  /** Re-run one capability's checks. Concurrent callers join the same run. */
  refreshCapability: (capabilityId: string) => Promise<CapabilityOperationOutcome>;
  /** Queue and follow an explicit runtime load test. Callers join one run. */
  testCapability: (capabilityId: string) => Promise<CapabilityOperationOutcome>;
  /**
   * Run this capability's install command and follow it to a terminal state.
   *
   * The command is not a parameter and never could be: the request carries a
   * capability id, and the backend derives what to run from its own tables.
   */
  installCapability: (capabilityId: string) => Promise<CapabilityOperationOutcome>;
  /** Ask the backend to stop an install. Concurrent callers join the same run. */
  cancelInstall: (capabilityId: string) => Promise<void>;
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

/** 45 minutes at one poll every 500ms — the backend's own install ceiling. */
const MAX_INSTALL_POLLS = 5_400;

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
    const installs = new Map<string, Promise<CapabilityOperationOutcome>>();

    // Every fetch that mutates the store runs through this chain. A full
    // refresh and a per-card recheck both invalidate the backend's shared
    // probe cache, so overlapping them would have each re-run the other's
    // probes and land results in whichever order they finished.
    let queue: Promise<unknown> = Promise.resolve();
    let probeGeneration = 0;
    const probeControllers = new Map<string, AbortController>();

    const installControllers = new Map<string, AbortController>();
    // The job id is remembered outside the store's per-capability record so a
    // cancel can reach the backend even while the poll response that would
    // have updated that record is still in flight.
    const installJobIds = new Map<string, string>();
    // Capabilities the user cancelled before their job id came back. Aborting
    // the POST would not undo a request the backend has already accepted — it
    // would only stop us hearing which job to cancel — so the intent is held
    // here and spent the moment the id lands.
    const pendingInstallCancels = new Set<string>();

    async function cancelInstallJob(
      capabilityId: string,
      jobId: string,
    ): Promise<void> {
      try {
        await cancelRuntimeCapabilityInstall(capabilityId, jobId);
      } catch (error) {
        set({ error: messageFor(error, `Failed to cancel ${capabilityId}`) });
      }
    }

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

    function patchInstall(
      capabilityId: string,
      patch: Partial<CapabilityInstallProgress>,
    ) {
      set((state) => {
        const current = state.installs[capabilityId] ?? {
          jobId: null,
          status: "starting" as const,
          message: "",
          log: [],
          error: null,
        };
        return {
          installs: {
            ...state.installs,
            [capabilityId]: { ...current, ...patch },
          },
        };
      });
    }

    function appendInstallLog(capabilityId: string, lines: string[]) {
      if (lines.length === 0) return;
      set((state) => {
        const current = state.installs[capabilityId];
        if (!current) return {};
        const log = [...current.log, ...lines];
        return {
          installs: {
            ...state.installs,
            [capabilityId]: {
              ...current,
              // Bounded: an install of torch prints thousands of lines, and
              // the panel only ever shows the end of them.
              log: log.slice(-MAX_INSTALL_LOG_LINES),
            },
          },
        };
      });
    }

    /**
     * One install, start to terminal state.
     *
     * The polling is the same shape as a load test's, with one difference that
     * matters: cancelling here stops the *backend* job, because an installer
     * left running would keep writing to the environment the user just decided
     * against.
     */
    async function runInstall(
      capabilityId: string,
    ): Promise<CapabilityOperationOutcome> {
      const controller = new AbortController();
      installControllers.set(capabilityId, controller);
      set((state) => ({
        installing: [...state.installing, capabilityId],
        installs: {
          ...state.installs,
          [capabilityId]: {
            jobId: null,
            status: "starting",
            message: "Starting the install…",
            log: [],
            error: null,
          },
        },
        error: null,
      }));

      let jobId: string | null = null;
      try {
        const started = await startRuntimeCapabilityInstall(capabilityId, {
          signal: controller.signal,
        });
        jobId = started.jobId;
        installJobIds.set(capabilityId, jobId);
        patchInstall(capabilityId, { jobId, status: "running" });
        if (pendingInstallCancels.delete(capabilityId)) {
          // Cancelled while the submission was in flight. The installer is
          // running by now, so this is the first moment it can be stopped.
          await cancelInstallJob(capabilityId, jobId);
        }

        let job = await getRuntimeCapabilityInstall(capabilityId, jobId);
        let seen = 0;
        let polls = 0;
        const drain = () => {
          const lines = job.diagnostics.slice(seen).map((entry) => entry.message);
          seen = job.diagnostics.length;
          appendInstallLog(capabilityId, lines);
          patchInstall(capabilityId, { message: job.message });
        };
        drain();
        while (job.status === "queued" || job.status === "running") {
          if (polls >= MAX_INSTALL_POLLS) {
            throw new Error("The install did not finish within 45 minutes");
          }
          polls += 1;
          await waitForPoll(controller.signal);
          job = await getRuntimeCapabilityInstall(capabilityId, jobId);
          drain();
        }

        if (job.status === "cancelled") {
          patchInstall(capabilityId, {
            status: "cancelled",
            message: "Install cancelled",
          });
          return CANCELLED;
        }

        if (job.status !== "succeeded") {
          const message = job.error ?? "The install failed";
          patchInstall(capabilityId, { status: "failed", error: message });
          set({ error: message });
          return { status: "failed", error: message };
        }

        patchInstall(capabilityId, {
          status: "succeeded",
          message: job.result?.summary ?? "Installed",
          error: null,
        });

        // Read the capability back rather than assuming: the backend dropped
        // its probe cache when the install finished, so this is the first
        // answer that describes the environment as it now is — including
        // whether a restart is what is left to do.
        const payload = await serialize(() =>
          getRuntimeCapability(capabilityId),
        );
        set((state) => ({
          status: "ready",
          capabilities: {
            ...state.capabilities,
            [payload.capability.id]: payload.capability,
          },
          environment: payload.environment,
        }));
        void useBackendRestartStore.getState().refresh();
        return SUCCEEDED;
      } catch (error) {
        if (isAbortError(error)) {
          patchInstall(capabilityId, { status: "cancelled" });
          return CANCELLED;
        }
        const message = messageFor(error, `Failed to install ${capabilityId}`);
        patchInstall(capabilityId, { status: "failed", error: message });
        set({ error: message });
        return { status: "failed", error: message };
      } finally {
        if (installControllers.get(capabilityId) === controller) {
          installControllers.delete(capabilityId);
        }
        installJobIds.delete(capabilityId);
        pendingInstallCancels.delete(capabilityId);
        set((state) => ({
          installing: state.installing.filter((id) => id !== capabilityId),
        }));
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
      installing: [],
      installs: {},

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

      installCapability: async (capabilityId) => {
        const inFlight = installs.get(capabilityId);
        if (inFlight) return inFlight;
        const running = runInstall(capabilityId).finally(() => {
          if (installs.get(capabilityId) === running) {
            installs.delete(capabilityId);
          }
        });
        installs.set(capabilityId, running);
        return running;
      },

      cancelInstall: async (capabilityId) => {
        const jobId = installJobIds.get(capabilityId);
        if (jobId !== undefined) {
          await cancelInstallJob(capabilityId, jobId);
          return;
        }
        // No job id yet. The submission may already have been accepted, so
        // abandoning the request here would report a cancellation while the
        // installer kept writing packages. Record the intent instead; the
        // submission spends it the moment it knows what to cancel.
        if (!installControllers.has(capabilityId)) return;
        pendingInstallCancels.add(capabilityId);
        patchInstall(capabilityId, { message: "Cancelling…" });
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
        for (const controller of installControllers.values()) {
          controller.abort();
        }
        installControllers.clear();
        installJobIds.clear();
        pendingInstallCancels.clear();
        inFlightLoad = null;
        refreshes.clear();
        tests.clear();
        installs.clear();
        queue = Promise.resolve();
        set({
          status: "idle",
          capabilities: {},
          environment: null,
          error: null,
          refreshing: [],
          testing: [],
          installing: [],
          installs: {},
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
