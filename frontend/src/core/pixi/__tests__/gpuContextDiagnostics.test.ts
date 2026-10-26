import type { Application } from "pixi.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGpuContextDiagnostics,
  registerGpuContext,
  resetGpuContextDiagnosticsForTests,
} from "../gpuContextDiagnostics";

interface FakeContext {
  application: Application;
  lose: (statusMessage?: string) => void;
}

function createFakeContext(width = 1280, height = 720): FakeContext {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  let lost = false;
  const gl = {
    RENDERER: 0x1f01,
    getExtension: () => null,
    getParameter: () => "Fake GPU",
    isContextLost: () => lost,
  };
  return {
    application: { canvas, renderer: { gl } } as unknown as Application,
    lose(statusMessage = "") {
      lost = true;
      const event = new Event("webglcontextlost");
      Object.defineProperty(event, "statusMessage", { value: statusMessage });
      canvas.dispatchEvent(event);
    },
  };
}

describe("GPU context diagnostics", () => {
  let groupCollapsed: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetGpuContextDiagnosticsForTests();
    groupCollapsed = vi.spyOn(console, "groupCollapsed").mockImplementation(() => {});
    vi.spyOn(console, "groupEnd").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports a shared loss as a GPU reset", () => {
    const player = createFakeContext();
    const offscreen = createFakeContext(832, 480);
    registerGpuContext("player", player.application);
    registerGpuContext("offscreen-render", offscreen.application);

    player.lose("GPU stall");
    offscreen.lose();
    vi.advanceTimersByTime(500);

    expect(groupCollapsed).toHaveBeenCalledTimes(1);
    expect(String(groupCollapsed.mock.calls[0][0])).toContain("(player)");
    expect(String(groupCollapsed.mock.calls[0][0])).toContain("GPU reset");
    expect(console.warn).toHaveBeenCalledWith("statusMessage: GPU stall");
  });

  it("reports a lone loss of the oldest context as the context limit", () => {
    const player = createFakeContext();
    registerGpuContext("player", player.application);
    vi.advanceTimersByTime(10);
    registerGpuContext("offscreen-render", createFakeContext().application);

    player.lose();
    vi.advanceTimersByTime(500);

    expect(String(groupCollapsed.mock.calls[0][0])).toContain(
      "active-context limit",
    );
  });

  it("still names a lost context its owner retired before the report", () => {
    const player = createFakeContext();
    const registration = registerGpuContext("player", player.application);
    registerGpuContext("offscreen-render", createFakeContext().application);

    player.lose();
    registration.dispose();
    vi.advanceTimersByTime(500);

    expect(String(groupCollapsed.mock.calls[0][0])).toContain("(player)");
    expect(console.warn).toHaveBeenCalledWith("live contexts: 2 (lost 1, alive 1)");
  });

  it("ignores the loss Pixi fires when destroying a disposed app", () => {
    const offscreen = createFakeContext();
    registerGpuContext("offscreen-render", offscreen.application).dispose();

    offscreen.lose();
    vi.advanceTimersByTime(500);

    expect(groupCollapsed).not.toHaveBeenCalled();
    expect(getGpuContextDiagnostics().live).toEqual([]);
    expect(getGpuContextDiagnostics().events).toHaveLength(2);
  });
});
