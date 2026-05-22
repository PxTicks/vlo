import { describe, expect, it } from "vitest";
import { TICKS_PER_SECOND } from "../../constants";
import {
  clampWaveformAssetTickToFirstSample,
  getFirstPresentedSampleTicks,
  resolveWaveformBucketRequestSeconds,
} from "../waveformTiming";

describe("waveformTiming", () => {
  it("returns zero when the first presented sample is at or before zero", () => {
    expect(getFirstPresentedSampleTicks()).toBe(0);
    expect(getFirstPresentedSampleTicks(0)).toBe(0);
    expect(getFirstPresentedSampleTicks(-0.05)).toBe(0);
  });

  it("clamps early waveform ticks to the first presented sample", () => {
    const firstTimestampSeconds = 0.041;
    const firstPresentedSampleTicks = Math.round(
      firstTimestampSeconds * TICKS_PER_SECOND,
    );

    expect(
      clampWaveformAssetTickToFirstSample(0, firstTimestampSeconds),
    ).toBe(firstPresentedSampleTicks);
    expect(
      clampWaveformAssetTickToFirstSample(1200, firstTimestampSeconds),
    ).toBe(firstPresentedSampleTicks);
    expect(
      clampWaveformAssetTickToFirstSample(8000, firstTimestampSeconds),
    ).toBe(8000);
  });

  it("does not clamp when the first sample timestamp is negative", () => {
    expect(clampWaveformAssetTickToFirstSample(0, -0.02)).toBe(0);
    expect(clampWaveformAssetTickToFirstSample(3000, -0.02)).toBe(3000);
  });

  it("never requests a sample before the real first sample (rounds up)", () => {
    // A first timestamp that scales to a fractional tick below x.5 must round
    // UP, otherwise the request lands before the first sample. See the
    // thumbnail proxy repro in thumbnailTiming.test.ts.
    const firstTimestampSeconds = 0.4686284722222222;

    const requestSeconds = resolveWaveformBucketRequestSeconds(
      0,
      2048,
      48_000,
      firstTimestampSeconds,
    );

    expect(requestSeconds).toBeGreaterThanOrEqual(firstTimestampSeconds);
    expect(getFirstPresentedSampleTicks(firstTimestampSeconds)).toBe(44989);
  });

  it("uses the first presented sample when a requested bucket starts before it", () => {
    const firstTimestampSeconds = 0.041;
    const requestSeconds = resolveWaveformBucketRequestSeconds(
      0,
      2048,
      48_000,
      firstTimestampSeconds,
    );

    expect(requestSeconds).toBeCloseTo(firstTimestampSeconds, 6);
    expect(
      resolveWaveformBucketRequestSeconds(4, 2048, 48_000, firstTimestampSeconds),
    ).toBeCloseTo((4 * 2048) / 48_000, 6);
  });
});
