// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "vlo.liveFrameGraph";
const COMPOSITE_STORAGE_KEY = "vlo.compositeRenderDag";

describe("framePlanningFlags", () => {
  beforeEach(() => {
    globalThis.localStorage.removeItem(STORAGE_KEY);
    globalThis.localStorage.removeItem(COMPOSITE_STORAGE_KEY);
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.localStorage.removeItem(STORAGE_KEY);
    globalThis.localStorage.removeItem(COMPOSITE_STORAGE_KEY);
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

  it("defaults direct composite DAG rendering on and supports programmatic rollback", async () => {
    const {
      isCompositeRenderDagEnabled,
      setCompositeRenderDagEnabled,
    } = await import("../framePlanningFlags");

    expect(isCompositeRenderDagEnabled()).toBe(true);
    setCompositeRenderDagEnabled(false);
    expect(isCompositeRenderDagEnabled()).toBe(false);
  });

  it("reads the persisted composite DAG rollback", async () => {
    globalThis.localStorage.setItem(COMPOSITE_STORAGE_KEY, "off");

    const { isCompositeRenderDagEnabled } = await import(
      "../framePlanningFlags"
    );

    expect(isCompositeRenderDagEnabled()).toBe(false);
  });
});
