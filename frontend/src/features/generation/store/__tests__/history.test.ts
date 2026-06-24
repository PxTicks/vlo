import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHistory: vi.fn(),
  parseHistoryOutputs: vi.fn(),
}));

vi.mock("../../services/comfyuiApi", () => ({
  getHistory: mocks.getHistory,
}));

vi.mock("../../services/parsers", () => ({
  parseHistoryOutputs: mocks.parseHistoryOutputs,
}));

import {
  getHistoryOutputsWithRetry,
  getPromptHistoryState,
  getPromptHistoryStateWithRetry,
} from "../history";

describe("generation history retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.getHistory.mockResolvedValue({ prompt: {} });
    mocks.parseHistoryOutputs.mockReturnValue({
      hasPromptEntry: false,
      outputs: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches and parses a single prompt history response", async () => {
    mocks.parseHistoryOutputs.mockReturnValue({
      hasPromptEntry: true,
      outputs: [{ filename: "result.png" }],
    });
    await expect(getPromptHistoryState("prompt-1")).resolves.toMatchObject({
      hasPromptEntry: true,
    });
    expect(mocks.getHistory).toHaveBeenCalledWith("prompt-1");
    expect(mocks.parseHistoryOutputs).toHaveBeenCalledWith(
      { prompt: {} },
      "prompt-1",
    );
  });

  it("returns immediately for an entry or output", async () => {
    mocks.parseHistoryOutputs.mockReturnValue({
      hasPromptEntry: false,
      outputs: [{ filename: "result.png" }],
    });
    await expect(
      getPromptHistoryStateWithRetry("prompt-1"),
    ).resolves.toMatchObject({ outputs: [{ filename: "result.png" }] });
    expect(mocks.getHistory).toHaveBeenCalledOnce();
  });

  it("retries empty responses and returns the final empty state", async () => {
    const promise = getPromptHistoryStateWithRetry("prompt-empty");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({
      hasPromptEntry: false,
      outputs: [],
    });
    expect(mocks.getHistory).toHaveBeenCalledTimes(4);
  });

  it("retries errors but returns a later successful response", async () => {
    mocks.getHistory
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue({ prompt: {} });
    mocks.parseHistoryOutputs.mockReturnValue({
      hasPromptEntry: true,
      outputs: [],
    });

    const promise = getPromptHistoryStateWithRetry("prompt-1");
    await vi.advanceTimersByTimeAsync(250);
    await expect(promise).resolves.toMatchObject({ hasPromptEntry: true });
  });

  it("throws the last error after all attempts fail", async () => {
    mocks.getHistory
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValueOnce(new Error("third"))
      .mockRejectedValueOnce(new Error("last"));

    const promise = getPromptHistoryStateWithRetry("prompt-1");
    const assertion = expect(promise).rejects.toThrow("last");
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("returns only outputs through the convenience helper", async () => {
    mocks.parseHistoryOutputs.mockReturnValue({
      hasPromptEntry: true,
      outputs: [{ filename: "one.png" }, { filename: "two.png" }],
    });
    await expect(getHistoryOutputsWithRetry("prompt-1")).resolves.toEqual([
      { filename: "one.png" },
      { filename: "two.png" },
    ]);
  });
});
