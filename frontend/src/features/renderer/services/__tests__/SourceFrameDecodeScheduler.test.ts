import { describe, it, expect, vi } from "vitest";
import { SourceFrameDecodeScheduler } from "../SourceFrameDecodeScheduler";
import type { DecodeWaiter } from "../SourceFrameDecodeScheduler";
import type { SourceFrameSyncIntent } from "../../utils/sourceFrameSync";

/**
 * Phase 1 decode-dedup coalescer. These tests exercise the scheduler in
 * isolation (no real decoder, no texture store): N waiters at one `decodeKey`
 * must trigger exactly one decode, stale waiters must be rejected by intent,
 * and the in-flight slot must clear so later ticks decode fresh.
 */

function intent(key: string, generation = 0): SourceFrameSyncIntent {
  return { key, generation };
}

/** A waiter whose intent never changes -> always current. */
function currentWaiter(key: string, generation = 0): DecodeWaiter {
  const captured = intent(key, generation);
  return { intent: captured, getCurrentIntent: () => captured };
}

/** A deferred promise we can resolve/reject from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SourceFrameDecodeScheduler", () => {
  it("coalesces concurrent waiters at one decodeKey into a single decode", async () => {
    const scheduler = new SourceFrameDecodeScheduler<string>();
    const control = deferred<string>();
    const decode = vi.fn(() => control.promise);

    const a = scheduler.acquire({
      decodeKey: "asset-1:2:30:0.066",
      waiter: currentWaiter("clip-a:asset-1:2:30:0.066"),
      decode,
    });
    const b = scheduler.acquire({
      decodeKey: "asset-1:2:30:0.066",
      waiter: currentWaiter("clip-b:asset-1:2:30:0.066"),
      decode,
    });

    expect(decode).toHaveBeenCalledTimes(1);
    expect(scheduler.inFlightCount).toBe(1);

    control.resolve("frame");
    const [resA, resB] = await Promise.all([a, b]);

    expect(resA).toEqual({ status: "fulfilled", frame: "frame" });
    expect(resB).toEqual({ status: "fulfilled", frame: "frame" });
    // Both waiters receive the identical shared frame value.
    expect((resA as { frame: string }).frame).toBe(
      (resB as { frame: string }).frame,
    );
  });

  it("runs a separate decode per distinct decodeKey", async () => {
    const scheduler = new SourceFrameDecodeScheduler<string>();
    const decode = vi.fn(async (value: string) => value);

    const a = scheduler.acquire({
      decodeKey: "asset-1:2:30:0.066",
      waiter: currentWaiter("clip-a"),
      decode: () => decode("a"),
    });
    const b = scheduler.acquire({
      decodeKey: "asset-2:2:30:0.066",
      waiter: currentWaiter("clip-b"),
      decode: () => decode("b"),
    });

    expect(scheduler.inFlightCount).toBe(2);
    await Promise.all([a, b]);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale waiter by intent while still fulfilling concurrent current waiters", async () => {
    const scheduler = new SourceFrameDecodeScheduler<string>();
    const control = deferred<string>();
    const decode = vi.fn(() => control.promise);

    // Stale waiter: its current intent advances past what it captured.
    const staleCaptured = intent("clip-a:f1", 1);
    const staleWaiter: DecodeWaiter = {
      intent: staleCaptured,
      getCurrentIntent: () => intent("clip-a:f1", 2),
    };

    const stale = scheduler.acquire({
      decodeKey: "asset-1:2:30:0.066",
      waiter: staleWaiter,
      decode,
    });
    const fresh = scheduler.acquire({
      decodeKey: "asset-1:2:30:0.066",
      waiter: currentWaiter("clip-b:f1"),
      decode,
    });

    // One decode for both, despite one being doomed to staleness.
    expect(decode).toHaveBeenCalledTimes(1);

    control.resolve("frame");
    const [staleResult, freshResult] = await Promise.all([stale, fresh]);

    // Stale waiters still receive the shared frame so the caller can dispose it
    // when no current consumer claims it.
    expect(staleResult).toEqual({ status: "stale", frame: "frame" });
    expect(freshResult).toEqual({ status: "fulfilled", frame: "frame" });
  });

  it("returns the shared frame to every waiter when an entire group goes stale", async () => {
    // The all-stale case: nothing claims the decode, so each waiter still gets
    // the frame and the caller is responsible for disposing it exactly once.
    const scheduler = new SourceFrameDecodeScheduler<string>();
    const control = deferred<string>();
    const decode = vi.fn(() => control.promise);

    const staleWaiter = (key: string): DecodeWaiter => ({
      intent: intent(key, 1),
      getCurrentIntent: () => intent(key, 2),
    });

    const a = scheduler.acquire({
      decodeKey: "asset-1:2:30:0.066",
      waiter: staleWaiter("clip-a"),
      decode,
    });
    const b = scheduler.acquire({
      decodeKey: "asset-1:2:30:0.066",
      waiter: staleWaiter("clip-b"),
      decode,
    });

    control.resolve("frame");
    const [resA, resB] = await Promise.all([a, b]);

    expect(decode).toHaveBeenCalledTimes(1);
    expect(resA).toEqual({ status: "stale", frame: "frame" });
    expect(resB).toEqual({ status: "stale", frame: "frame" });
    // Same shared frame instance handed to both — the caller frees it once.
    expect((resA as { frame: string }).frame).toBe(
      (resB as { frame: string }).frame,
    );
  });

  it("treats a waiter whose clip is gone (null current intent) as stale", async () => {
    const scheduler = new SourceFrameDecodeScheduler<string>();
    const captured = intent("clip-a:f1", 0);
    const goneWaiter: DecodeWaiter = {
      intent: captured,
      getCurrentIntent: () => null,
    };

    const result = await scheduler.acquire({
      decodeKey: "asset-1:2:30:0.066",
      waiter: goneWaiter,
      decode: async () => "frame",
    });

    expect(result).toEqual({ status: "stale", frame: "frame" });
  });

  it("clears the in-flight slot after settling so a later request decodes fresh", async () => {
    const scheduler = new SourceFrameDecodeScheduler<string>();
    const decode = vi.fn(async () => "frame");

    await scheduler.acquire({
      decodeKey: "asset-1:2:30:0.066",
      waiter: currentWaiter("clip-a"),
      decode,
    });
    expect(scheduler.inFlightCount).toBe(0);

    await scheduler.acquire({
      decodeKey: "asset-1:2:30:0.066",
      waiter: currentWaiter("clip-a"),
      decode,
    });

    // A new tick at the same key after the first settled => a second decode.
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("propagates decode errors to every joined waiter and clears the slot for retry", async () => {
    const scheduler = new SourceFrameDecodeScheduler<string>();
    const failing = deferred<string>();
    const failingDecode = vi.fn(() => failing.promise);

    const a = scheduler.acquire({
      decodeKey: "asset-1:2:30:0.066",
      waiter: currentWaiter("clip-a"),
      decode: failingDecode,
    });
    const b = scheduler.acquire({
      decodeKey: "asset-1:2:30:0.066",
      waiter: currentWaiter("clip-b"),
      decode: failingDecode,
    });

    expect(failingDecode).toHaveBeenCalledTimes(1);
    failing.reject(new Error("decode boom"));

    await expect(a).rejects.toThrow("decode boom");
    await expect(b).rejects.toThrow("decode boom");
    expect(scheduler.inFlightCount).toBe(0);

    // Slot cleared -> a retry actually re-invokes decode.
    const retryDecode = vi.fn(async () => "frame");
    const retry = await scheduler.acquire({
      decodeKey: "asset-1:2:30:0.066",
      waiter: currentWaiter("clip-a"),
      decode: retryDecode,
    });
    expect(retryDecode).toHaveBeenCalledTimes(1);
    expect(retry).toEqual({ status: "fulfilled", frame: "frame" });
  });

  it("handles a synchronous throw from the decode factory as a rejected decode", async () => {
    const scheduler = new SourceFrameDecodeScheduler<string>();

    const result = scheduler.acquire({
      decodeKey: "asset-1:2:30:0.066",
      waiter: currentWaiter("clip-a"),
      decode: () => {
        throw new Error("sync boom");
      },
    });

    await expect(result).rejects.toThrow("sync boom");
    expect(scheduler.inFlightCount).toBe(0);
  });
});
