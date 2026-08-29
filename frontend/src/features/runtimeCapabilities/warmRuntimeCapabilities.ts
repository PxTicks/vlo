import { useRuntimeCapabilityStore } from "./useRuntimeCapabilityStore";

/**
 * Fetch the capability snapshot once, in the background, at app startup.
 *
 * The first read of a capability runs out-of-process import probes and can
 * take upwards of ten seconds. Doing that lazily meant the cost landed on the
 * user at the worst moment — "Extract Selection" opened onto a progress bar
 * instead of the prompt form. Paying it while nothing is waiting on it means
 * the answer is already in the store by the time a surface asks.
 *
 * Deliberately best-effort: a backend that is not up yet leaves the store in
 * its error state, and `ensureLoaded` re-fetches the next time a surface
 * mounts, so nothing is worse off than before the warm-up existed.
 */
export function warmRuntimeCapabilities(): void {
  const run = () => {
    void useRuntimeCapabilityStore.getState().ensureLoaded();
  };

  // Idle time, not mount time: the probes are for a feature the user has not
  // reached yet, and they must not compete with the editor's own boot work.
  const idle = globalThis.requestIdleCallback;
  if (typeof idle === "function") {
    idle(run, { timeout: 5_000 });
    return;
  }
  globalThis.setTimeout(run, 2_000);
}
