import { afterEach, describe, expect, it, vi } from "vitest";

function audioContextMock(state: AudioContextState = "running") {
  const gain = {
    gain: { value: 1 },
    connect: vi.fn(),
  };
  const context = {
    state,
    currentTime: 10,
    destination: { id: "destination" },
    createGain: vi.fn(() => gain),
    resume: vi.fn(async () => undefined),
  };
  const Constructor = vi.fn(function () {
    return context;
  });
  return { Constructor, context, gain };
}

async function loadAudioSystem() {
  vi.resetModules();
  return import("../services/AudioSystem");
}

describe("AudioSystem", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "webkitAudioContext");
    Reflect.deleteProperty(window, "AudioContext");
  });

  it("operates safely when Web Audio is unavailable", async () => {
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: undefined,
    });
    const { AudioSystem } = await loadAudioSystem();
    const system = new AudioSystem();

    expect(system.getContext()).toBeNull();
    expect(system.getMasterGain()).toBeNull();
    system.setVolume(0.5);
    system.notifyPlay(240);
    expect(system.getCurrentPlaybackTicks()).toBe(0);
    expect(system.ticksToContextTime(300)).toBe(0);
    expect(system.getStartTime()).toBe(0);
    await expect(system.resume()).resolves.toBeUndefined();
  });

  it("creates a 48kHz context and connects the master gain", async () => {
    const { Constructor, context, gain } = audioContextMock();
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: Constructor,
    });
    const { AudioSystem } = await loadAudioSystem();
    const system = new AudioSystem();

    expect(Constructor).toHaveBeenCalledWith({ sampleRate: 48000 });
    expect(context.createGain).toHaveBeenCalled();
    expect(gain.connect).toHaveBeenCalledWith(context.destination);
    system.setVolume(0.35);
    expect(gain.gain.value).toBe(0.35);
  });

  it("falls back to webkitAudioContext", async () => {
    const { Constructor, context } = audioContextMock();
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, "webkitAudioContext", {
      configurable: true,
      value: Constructor,
    });
    const { AudioSystem } = await loadAudioSystem();
    expect(new AudioSystem().getContext()).toBe(context);
  });

  it("resumes suspended contexts and handles resume failures", async () => {
    const { Constructor, context } = audioContextMock("suspended");
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: Constructor,
    });
    const { AudioSystem } = await loadAudioSystem();
    const system = new AudioSystem();
    await system.resume();
    expect(context.resume).toHaveBeenCalled();

    context.resume.mockRejectedValueOnce(new Error("blocked"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(system.resume()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "AudioContext resume failed",
      expect.any(Error),
    );
  });

  it("maps between timeline ticks and the audio clock", async () => {
    const { Constructor, context } = audioContextMock();
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: Constructor,
    });
    const { AudioSystem } = await loadAudioSystem();
    const system = new AudioSystem();
    system.notifyPlay(96000);
    expect(system.getStartTime()).toBe(10);

    context.currentTime = 10.5;
    expect(system.getCurrentPlaybackTicks()).toBe(144000);
    expect(system.ticksToContextTime(192000)).toBe(11);
  });
});
