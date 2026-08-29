import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeCapabilityStore } from "../useRuntimeCapabilityStore";
import { warmRuntimeCapabilities } from "../warmRuntimeCapabilities";

describe("warmRuntimeCapabilities", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useRuntimeCapabilityStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads the snapshot once idle time arrives", () => {
    const ensureLoaded = vi
      .spyOn(useRuntimeCapabilityStore.getState(), "ensureLoaded")
      .mockResolvedValue(undefined);
    const host = globalThis as { requestIdleCallback?: unknown };
    const original = host.requestIdleCallback;
    const idle = vi.fn((callback: () => void) => {
      callback();
      return 1;
    });
    host.requestIdleCallback = idle;

    try {
      warmRuntimeCapabilities();
      expect(idle).toHaveBeenCalled();
      expect(ensureLoaded).toHaveBeenCalledTimes(1);
    } finally {
      host.requestIdleCallback = original;
    }
  });

  it("falls back to a timeout where idle callbacks are unavailable", () => {
    const ensureLoaded = vi
      .spyOn(useRuntimeCapabilityStore.getState(), "ensureLoaded")
      .mockResolvedValue(undefined);
    const host = globalThis as { requestIdleCallback?: unknown };
    const original = host.requestIdleCallback;
    host.requestIdleCallback = undefined;

    try {
      warmRuntimeCapabilities();
      expect(ensureLoaded).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
      expect(ensureLoaded).toHaveBeenCalledTimes(1);
    } finally {
      host.requestIdleCallback = original;
    }
  });
});
