/**
 * Yield control to the event loop without paying the nested-timer clamp.
 *
 * Long render loops must hand the main thread back periodically so progress UI
 * repaints and cancellation stays responsive. The obvious spelling —
 * `await new Promise((resolve) => setTimeout(resolve, 0))` — is a trap inside a
 * loop: each timer is scheduled from within the previous timer's callback, so
 * the HTML spec's nesting counter climbs, and past five levels browsers clamp a
 * `0` timeout to a **4ms floor**. An export that yields every few frames then
 * burns whole milliseconds per yield doing nothing.
 *
 * `scheduler.yield()` exists precisely for this and carries no clamp. Where it
 * is unavailable, a `MessageChannel` round-trip is the long-standing equivalent:
 * it posts a macrotask that is never subject to timer clamping.
 */

interface SchedulerWithYield {
  yield?: () => Promise<void>;
}

/**
 * Resolves on a fresh macrotask, allowing rendering and input to run first.
 * Prefers `scheduler.yield()`, falls back to `MessageChannel`, then `setTimeout`.
 */
export function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerWithYield }).scheduler;
  if (typeof scheduler?.yield === "function") {
    return scheduler.yield();
  }

  if (typeof MessageChannel === "function") {
    return new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(undefined);
    });
  }

  // Last resort for environments with neither (some test/worker shims). Clamped,
  // but correctness beats speed on a path that should never be reached.
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
