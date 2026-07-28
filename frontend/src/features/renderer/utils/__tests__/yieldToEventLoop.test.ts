import { afterEach, describe, expect, it, vi } from "vitest";
import { yieldToEventLoop } from "../yieldToEventLoop";

interface MutableGlobal {
  scheduler?: { yield?: () => Promise<void> };
}

const globalRef = globalThis as MutableGlobal;

afterEach(() => {
  delete globalRef.scheduler;
  vi.restoreAllMocks();
});

describe("yieldToEventLoop", () => {
  it("prefers scheduler.yield when the platform provides it", async () => {
    const schedulerYield = vi.fn(() => Promise.resolve());
    globalRef.scheduler = { yield: schedulerYield };

    await yieldToEventLoop();

    expect(schedulerYield).toHaveBeenCalledTimes(1);
  });

  it("falls back to a MessageChannel macrotask without scheduler.yield", async () => {
    delete globalRef.scheduler;
    const timeout = vi.spyOn(globalThis, "setTimeout");

    await expect(yieldToEventLoop()).resolves.toBeUndefined();

    // The clamped timer path is the last resort and must stay unused wherever
    // MessageChannel exists — that clamp is the whole reason this helper exists.
    expect(timeout).not.toHaveBeenCalled();
  });

  it("stays resolvable across repeated back-to-back yields", async () => {
    delete globalRef.scheduler;

    // A render loop calls this hundreds of times in sequence; a helper that
    // leaked ports or resolved once would surface here.
    for (let i = 0; i < 50; i += 1) {
      await yieldToEventLoop();
    }

    expect(true).toBe(true);
  });

  it("tolerates a scheduler object that has no yield function", async () => {
    globalRef.scheduler = {};

    await expect(yieldToEventLoop()).resolves.toBeUndefined();
  });
});
