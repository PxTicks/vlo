import { describe, expect, it, vi } from "vitest";
import {
  createMediaTimestampRange,
  mediaSecondsToTick,
  mediaTimestampRangeProgress,
  readMediaTimestampRange,
  tickToMediaSeconds,
} from "../mediaTime";

describe("core media time", () => {
  it("round-trips integer ticks without floating-point boundary drift", () => {
    for (const tick of [0, 1, 7, 95_999, 96_000, 12_345_678]) {
      const seconds = tickToMediaSeconds(tick);
      expect(mediaSecondsToTick(seconds, "floor")).toBe(tick);
      expect(mediaSecondsToTick(seconds, "ceil")).toBe(tick);
    }
  });

  it.each([
    { first: 2, end: 5, duration: 3 },
    { first: -2, end: 1, duration: 3 },
    { first: -1, end: -1, duration: 0 },
  ])("separates timestamp bounds from span for $first..$end", ({
    first,
    end,
    duration,
  }) => {
    expect(createMediaTimestampRange(first, end)).toEqual({
      firstTimestampSeconds: first,
      endTimestampSeconds: end,
      durationSeconds: duration,
    });
  });

  it("rejects malformed timestamp ranges", () => {
    expect(createMediaTimestampRange(2, 1)).toBeNull();
    expect(createMediaTimestampRange(Number.NaN, 1)).toBeNull();
    expect(createMediaTimestampRange(0, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("reads and measures decoder timestamp ranges", async () => {
    const range = await readMediaTimestampRange({
      getFirstTimestamp: vi.fn(async () => 2),
      computeDuration: vi.fn(async () => 5),
    });
    expect(range).toEqual({
      firstTimestampSeconds: 2,
      endTimestampSeconds: 5,
      durationSeconds: 3,
    });
    expect(mediaTimestampRangeProgress(3.5, range!)).toBe(0.5);
  });

  it("settles both decoder probes before propagating a failure", async () => {
    const durationError = new Error("duration failed");
    const computeDuration = vi.fn(() => {
      throw durationError;
    });
    const getFirstTimestamp = vi.fn(async () => {
      throw new Error("timestamp failed");
    });

    await expect(
      readMediaTimestampRange({ computeDuration, getFirstTimestamp }),
    ).rejects.toBe(durationError);
    expect(computeDuration).toHaveBeenCalledOnce();
    expect(getFirstTimestamp).toHaveBeenCalledOnce();
  });
});
