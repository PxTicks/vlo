// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "vlo.liveFrameGraph";

describe("framePlanningFlags", () => {
  beforeEach(() => {
    globalThis.localStorage.removeItem(STORAGE_KEY);
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.localStorage.removeItem(STORAGE_KEY);
  });

  it("defaults to enabled", async () => {
    const { isLiveFrameGraphEnabled } = await import("../framePlanningFlags");

    expect(isLiveFrameGraphEnabled()).toBe(true);
  });

  it("reads the persisted rollback override during module initialization", async () => {
    globalThis.localStorage.setItem(STORAGE_KEY, "off");

    const { isLiveFrameGraphEnabled } = await import("../framePlanningFlags");

    expect(isLiveFrameGraphEnabled()).toBe(false);
  });

  it("reflects the programmatic override", async () => {
    const { isLiveFrameGraphEnabled, setLiveFrameGraphEnabled } = await import(
      "../framePlanningFlags"
    );

    setLiveFrameGraphEnabled(false);
    expect(isLiveFrameGraphEnabled()).toBe(false);
    setLiveFrameGraphEnabled(true);
    expect(isLiveFrameGraphEnabled()).toBe(true);
  });
});
