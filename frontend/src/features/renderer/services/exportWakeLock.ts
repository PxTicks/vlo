/**
 * Keeps the machine awake for the duration of a render job.
 *
 * A long export is CPU/GPU-busy but generates no user input, and OS idle-sleep
 * timers key off input, not load. Without an assertion the display sleeps and
 * the machine can suspend mid-render, which at best stalls the export and at
 * worst loses it.
 *
 * The Screen Wake Lock API is the browser's assertion. Two properties shape this
 * wrapper:
 *
 * - `request()` rejects when the document is hidden, so it can never be assumed
 *   to succeed. Every failure here is non-fatal — the export proceeds without
 *   the lock.
 * - The lock is auto-released whenever the document becomes hidden, and is *not*
 *   restored on return. We re-acquire on `visibilitychange` so a user who tabs
 *   away and comes back is protected for the remainder of the job.
 *
 * This does not help while the tab is hidden — nothing in the browser does; that
 * is the gap the desktop shell's `powerSaveBlocker` closes (see
 * docs/electron-desktop-plan.md §4.2).
 */

export interface ExportWakeLockHandle {
  /** Idempotent. Releases the lock and stops re-acquiring it. */
  release: () => void;
}

interface WakeLockSentinelLike {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
  removeEventListener?: (type: "release", listener: () => void) => void;
}

interface WakeLockNavigator {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
}

/**
 * Acquire a screen wake lock for a render job. Never throws and never rejects;
 * returns a handle whose `release` is safe to call multiple times, including
 * when the lock was never granted.
 */
export function acquireExportWakeLock(): ExportWakeLockHandle {
  if (typeof navigator === "undefined" || typeof document === "undefined") {
    return { release: () => {} };
  }

  const wakeLock = (navigator as Navigator & WakeLockNavigator).wakeLock;
  if (!wakeLock) {
    return { release: () => {} };
  }

  let sentinel: WakeLockSentinelLike | null = null;
  let removeSentinelReleaseListener: (() => void) | null = null;
  let requestGeneration = 0;
  let pendingRequestGeneration: number | null = null;
  let releasedByCaller = false;

  const clearSentinel = () => {
    removeSentinelReleaseListener?.();
    removeSentinelReleaseListener = null;
    sentinel = null;
  };

  const request = () => {
    if (releasedByCaller || sentinel || pendingRequestGeneration !== null) return;
    // Hidden documents always reject; skip the guaranteed failure.
    if (document.visibilityState !== "visible") {
      return;
    }

    const generation = requestGeneration + 1;
    requestGeneration = generation;
    pendingRequestGeneration = generation;

    let requestPromise: Promise<WakeLockSentinelLike>;
    try {
      requestPromise = wakeLock.request("screen");
    } catch {
      pendingRequestGeneration = null;
      return;
    }

    void requestPromise
      .then((granted) => {
        if (pendingRequestGeneration === generation) {
          pendingRequestGeneration = null;
        }

        if (
          releasedByCaller ||
          generation !== requestGeneration ||
          document.visibilityState !== "visible" ||
          granted.released
        ) {
          if (!granted.released) {
            void granted.release().catch(() => {});
          }
          return;
        }

        sentinel = granted;
        const handleRelease = () => {
          if (sentinel !== granted) return;
          clearSentinel();
          if (document.visibilityState === "visible") {
            request();
          }
        };
        granted.addEventListener?.("release", handleRelease);
        removeSentinelReleaseListener = () => {
          granted.removeEventListener?.("release", handleRelease);
        };
      })
      .catch(() => {
        if (pendingRequestGeneration === generation) {
          pendingRequestGeneration = null;
        }
        // Denied by policy, hidden document, or unsupported surface. The export
        // is unaffected; the machine may simply sleep as it does today.
      });
  };

  const handleVisibilityChange = () => {
    if (releasedByCaller) return;
    if (document.visibilityState !== "visible") {
      // Invalidate both granted and in-flight locks. A late grant is explicitly
      // released, while the next visible transition can request a fresh one.
      requestGeneration += 1;
      pendingRequestGeneration = null;
      clearSentinel();
      return;
    }
    request();
  };

  request();
  document.addEventListener("visibilitychange", handleVisibilityChange);

  return {
    release: () => {
      if (releasedByCaller) return;
      releasedByCaller = true;
      requestGeneration += 1;
      pendingRequestGeneration = null;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      const active = sentinel;
      clearSentinel();
      if (active && !active.released) {
        void active.release().catch(() => {});
      }
    },
  };
}
