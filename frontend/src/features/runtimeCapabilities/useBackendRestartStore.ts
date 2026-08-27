import { create } from "zustand";
import {
  getBackendLifecycle,
  restartBackend,
} from "../../services/runtimeApi";
import type { BackendLifecycleState } from "../../types/RuntimeStatus";

/**
 * The backend's restart state, and the wait across a restart.
 *
 * An install writes packages into the environment the backend is already
 * running out of, which the running process cannot be relied on to pick up.
 * So the backend records that a restart is owed, and this store is what turns
 * that into something the user can act on.
 *
 * Waiting is done by *identity, not by liveness*: the backend hands out an
 * `instanceId` that changes exactly once, when a genuinely new process
 * answers. Polling for "does it respond" would finish immediately — the old
 * process is still answering when the request returns, and stays up for
 * another moment after that.
 */
export type BackendRestartStatus =
  | "idle"
  /** The request has been sent; the process has not gone yet. */
  | "requesting"
  /** The old process is gone or going; waiting for a new instance id. */
  | "waiting"
  /** A new instance answered. The page reloads immediately after. */
  | "restarted"
  | "failed";

export interface BackendRestartStoreState {
  status: BackendRestartStatus;
  lifecycle: BackendLifecycleState | null;
  error: string | null;
  /** Re-read what the backend says without asking it to do anything. */
  refresh: () => Promise<void>;
  /**
   * Restart the backend and wait for a new process to answer.
   *
   * `force` overrides the in-flight GPU work guard, and only that.
   */
  restart: (options?: { force?: boolean }) => Promise<boolean>;
  reset: () => void;
}

/** How long to keep waiting for a new process before giving up on it. */
const RESTART_TIMEOUT_MS = 120_000;
const RESTART_POLL_INTERVAL_MS = 750;

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function waitForNewInstance(previousInstanceId: string): Promise<boolean> {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(RESTART_POLL_INTERVAL_MS);
    try {
      const state = await getBackendLifecycle();
      if (state.instanceId !== previousInstanceId) return true;
      // Same id: this is the process we asked to go, still answering. Keep
      // waiting rather than declaring success on a live connection.
    } catch {
      // Expected, and repeatedly: the socket is closed for the whole of the
      // restart. A failed poll is the normal middle of this operation.
    }
  }
  return false;
}

export const useBackendRestartStore = create<BackendRestartStoreState>(
  (set, get) => ({
    status: "idle",
    lifecycle: null,
    error: null,

    refresh: async () => {
      try {
        const lifecycle = await getBackendLifecycle();
        set((state) => ({
          lifecycle,
          // A restart in progress owns the status; a background refresh that
          // is only reporting what the old process still says must not clear
          // the waiting state out from under it.
          status: state.status === "idle" ? "idle" : state.status,
          error: null,
        }));
      } catch (error) {
        set({ error: messageFor(error, "Failed to read the backend state") });
      }
    },

    restart: async (options = {}) => {
      const previous =
        get().lifecycle?.instanceId ??
        (await getBackendLifecycle().catch(() => null))?.instanceId ??
        null;
      set({ status: "requesting", error: null });

      try {
        await restartBackend(options);
      } catch (error) {
        set({
          status: "failed",
          error: messageFor(error, "The backend refused to restart"),
        });
        return false;
      }

      if (previous === null) {
        // Without a previous id there is nothing to compare against, so the
        // honest thing is to stop here rather than reload the page on a guess.
        set({
          status: "failed",
          error:
            "The backend is restarting, but its state could not be read " +
            "first. Reload this page in a moment.",
        });
        return false;
      }

      set({ status: "waiting" });
      const restarted = await waitForNewInstance(previous);
      if (!restarted) {
        set({
          status: "failed",
          error:
            "The backend did not come back within two minutes. Check the " +
            "terminal it is running in.",
        });
        return false;
      }

      set({ status: "restarted" });
      return true;
    },

    reset: () => set({ status: "idle", lifecycle: null, error: null }),
  }),
);
