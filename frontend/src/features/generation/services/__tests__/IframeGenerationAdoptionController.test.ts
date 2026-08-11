import { afterEach, describe, expect, it, vi } from "vitest";
import { IframeGenerationAdoptionController } from "../IframeGenerationAdoptionController";

const METADATA = {
  inputs: [],
};

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("IframeGenerationAdoptionController", () => {
  it("retries a transient adoption failure until the delivery is registered", async () => {
    vi.useFakeTimers();
    const adopt = vi
      .fn()
      .mockRejectedValueOnce(new Error("backend unavailable"))
      .mockResolvedValue(undefined);
    const controller = new IframeGenerationAdoptionController({
      adopt,
      reportProgress: vi.fn().mockResolvedValue(undefined),
      warn: vi.fn(),
    });

    controller.observe(
      "project-1",
      {
        promptId: "prompt-1",
        phase: "started",
        value: null,
        max: null,
        node: null,
      },
      METADATA,
    );
    await flushPromises();

    expect(adopt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(adopt).toHaveBeenCalledTimes(2);
    expect(adopt).toHaveBeenLastCalledWith("project-1", "prompt-1", {
      generationMetadata: METADATA,
    });
    controller.dispose();
  });

  it("adopts from a progress event and reports progress only after adoption", async () => {
    let resolveAdoption!: () => void;
    const adoption = new Promise<void>((resolve) => {
      resolveAdoption = resolve;
    });
    const reportProgress = vi.fn().mockResolvedValue(undefined);
    const controller = new IframeGenerationAdoptionController({
      adopt: vi.fn(() => adoption),
      reportProgress,
      warn: vi.fn(),
    });

    controller.observe(
      "project-1",
      {
        promptId: "prompt-1",
        phase: "progress",
        value: 3,
        max: 4,
        node: "sampler",
      },
      METADATA,
    );
    expect(reportProgress).not.toHaveBeenCalled();

    resolveAdoption();
    await flushPromises();

    expect(reportProgress).toHaveBeenCalledWith("project-1", "prompt-1", {
      progress: 75,
      node: "sampler",
    });
    controller.dispose();
  });

  it("still adopts when the first observed event is terminal", async () => {
    const adopt = vi.fn().mockResolvedValue(undefined);
    const controller = new IframeGenerationAdoptionController({
      adopt,
      reportProgress: vi.fn().mockResolvedValue(undefined),
      warn: vi.fn(),
    });

    controller.observe(
      "project-1",
      {
        promptId: "prompt-fast",
        phase: "finished",
        value: null,
        max: null,
        node: null,
      },
      METADATA,
    );
    await flushPromises();

    expect(adopt).toHaveBeenCalledWith("project-1", "prompt-fast", {
      generationMetadata: METADATA,
    });
    controller.dispose();
  });

  it("stops retrying after the bounded fallback attempt budget", async () => {
    vi.useFakeTimers();
    const adopt = vi.fn().mockRejectedValue(new Error("permanent failure"));
    const warn = vi.fn();
    const controller = new IframeGenerationAdoptionController({
      adopt,
      reportProgress: vi.fn().mockResolvedValue(undefined),
      warn,
    });

    controller.observe(
      "project-1",
      {
        promptId: "prompt-broken",
        phase: "started",
        value: null,
        max: null,
        node: null,
      },
      METADATA,
    );
    await vi.runAllTimersAsync();
    await flushPromises();

    expect(adopt).toHaveBeenCalledTimes(8);
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("does not schedule a retry when an in-flight adoption fails after disposal", async () => {
    vi.useFakeTimers();
    let rejectAdoption!: (error: Error) => void;
    const adoption = new Promise<void>((_resolve, reject) => {
      rejectAdoption = reject;
    });
    const adopt = vi.fn(() => adoption);
    const controller = new IframeGenerationAdoptionController({
      adopt,
      reportProgress: vi.fn().mockResolvedValue(undefined),
      warn: vi.fn(),
    });

    controller.observe(
      "project-1",
      {
        promptId: "prompt-disposed",
        phase: "started",
        value: null,
        max: null,
        node: null,
      },
      METADATA,
    );
    controller.dispose();
    rejectAdoption(new Error("late failure"));
    await flushPromises();

    expect(adopt).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
