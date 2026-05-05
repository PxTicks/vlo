import { beforeEach, describe, expect, it } from "vitest";
import {
  waveformCacheService,
  WAVEFORM_BASE_SAMPLES_PER_PEAK,
  WAVEFORM_PEAKS_PER_BUCKET,
} from "../WaveformCacheService";

function createBucket(seed: number): Int16Array {
  const bucket = new Int16Array(WAVEFORM_PEAKS_PER_BUCKET * 2);
  for (let peakIndex = 0; peakIndex < WAVEFORM_PEAKS_PER_BUCKET; peakIndex++) {
    const offset = peakIndex * 2;
    bucket[offset] = seed + peakIndex;
    bucket[offset + 1] = seed + peakIndex + 1000;
  }
  return bucket;
}

describe("WaveformCacheService", () => {
  beforeEach(() => {
    waveformCacheService.clearAll();
  });

  it("tracks references and clears buckets when the final reference is released", () => {
    waveformCacheService.acquire("asset-1");
    waveformCacheService.acquire("asset-1");
    waveformCacheService.setMetadata("asset-1", {
      sampleRate: 48_000,
      numberOfChannels: 2,
      durationSeconds: 5,
      firstTimestampSeconds: 0.05,
      baseSamplesPerPeak: WAVEFORM_BASE_SAMPLES_PER_PEAK,
      peaksPerBucket: WAVEFORM_PEAKS_PER_BUCKET,
    });
    waveformCacheService.setBucket("asset-1", 0, 0, createBucket(-500));

    expect(waveformCacheService.getRefCount("asset-1")).toBe(2);
    expect(waveformCacheService.hasAnyBuckets("asset-1")).toBe(true);

    waveformCacheService.release("asset-1");
    expect(waveformCacheService.getRefCount("asset-1")).toBe(1);
    expect(waveformCacheService.hasAnyBuckets("asset-1")).toBe(true);

    waveformCacheService.release("asset-1");
    expect(waveformCacheService.getRefCount("asset-1")).toBe(0);
    expect(waveformCacheService.hasAnyBuckets("asset-1")).toBe(false);
  });

  it("derives coarser parent buckets once sibling child buckets are present", () => {
    waveformCacheService.acquire("asset-1");
    waveformCacheService.setMetadata("asset-1", {
      sampleRate: 48_000,
      numberOfChannels: 1,
      durationSeconds: 30,
      firstTimestampSeconds: 0,
      baseSamplesPerPeak: WAVEFORM_BASE_SAMPLES_PER_PEAK,
      peaksPerBucket: WAVEFORM_PEAKS_PER_BUCKET,
    });

    const left = createBucket(-100);
    const right = createBucket(-300);
    waveformCacheService.setBucket("asset-1", 0, 0, left);
    waveformCacheService.setBucket("asset-1", 0, 1, right);

    const parent = waveformCacheService.getBucket("asset-1", 1, 0);
    expect(parent).toBeDefined();
    expect(parent?.[0]).toBe(Math.min(left[0]!, left[2]!));
    expect(parent?.[1]).toBe(Math.max(left[1]!, left[3]!));
    const midpointOffset = WAVEFORM_PEAKS_PER_BUCKET;
    expect(parent?.[midpointOffset]).toBe(Math.min(right[0]!, right[2]!));
    expect(parent?.[midpointOffset + 1]).toBe(Math.max(right[1]!, right[3]!));
  });

  it("preserves waveform ordering when reducing across sibling buckets", () => {
    waveformCacheService.acquire("asset-1");
    waveformCacheService.setMetadata("asset-1", {
      sampleRate: 48_000,
      numberOfChannels: 1,
      durationSeconds: 30,
      firstTimestampSeconds: 0,
      baseSamplesPerPeak: WAVEFORM_BASE_SAMPLES_PER_PEAK,
      peaksPerBucket: WAVEFORM_PEAKS_PER_BUCKET,
    });

    const left = new Int16Array(WAVEFORM_PEAKS_PER_BUCKET * 2);
    const right = new Int16Array(WAVEFORM_PEAKS_PER_BUCKET * 2);

    for (let peakIndex = 0; peakIndex < WAVEFORM_PEAKS_PER_BUCKET; peakIndex++) {
      const offset = peakIndex * 2;
      left[offset] = -100;
      left[offset + 1] = 100;
      right[offset] = -1000;
      right[offset + 1] = 1000;
    }

    waveformCacheService.setBucket("asset-1", 0, 0, left);
    waveformCacheService.setBucket("asset-1", 0, 1, right);

    const parent = waveformCacheService.getBucket("asset-1", 1, 0);
    expect(parent).toBeDefined();

    for (let peakIndex = 0; peakIndex < WAVEFORM_PEAKS_PER_BUCKET / 2; peakIndex++) {
      const offset = peakIndex * 2;
      expect(parent?.[offset]).toBe(-100);
      expect(parent?.[offset + 1]).toBe(100);
    }

    for (
      let peakIndex = WAVEFORM_PEAKS_PER_BUCKET / 2;
      peakIndex < WAVEFORM_PEAKS_PER_BUCKET;
      peakIndex++
    ) {
      const offset = peakIndex * 2;
      expect(parent?.[offset]).toBe(-1000);
      expect(parent?.[offset + 1]).toBe(1000);
    }
  });

  it("falls back to the nearest coarser cached bucket when the exact level is missing", () => {
    waveformCacheService.acquire("asset-1");
    waveformCacheService.setMetadata("asset-1", {
      sampleRate: 48_000,
      numberOfChannels: 2,
      durationSeconds: 60,
      firstTimestampSeconds: 0,
      baseSamplesPerPeak: WAVEFORM_BASE_SAMPLES_PER_PEAK,
      peaksPerBucket: WAVEFORM_PEAKS_PER_BUCKET,
    });
    waveformCacheService.setBucket("asset-1", 2, 0, createBucket(-1000));

    const match = waveformCacheService.findClosestBucket("asset-1", 0, 10);
    expect(match).not.toBeNull();
    expect(match?.level).toBe(2);
    expect(match?.bucketIndex).toBe(0);
    expect(match?.peakIndex).toBe(2);
  });

  it("tracks memory usage for cached typed arrays", () => {
    waveformCacheService.acquire("asset-1");
    waveformCacheService.setMetadata("asset-1", {
      sampleRate: 48_000,
      numberOfChannels: 1,
      durationSeconds: 5,
      firstTimestampSeconds: 0,
      baseSamplesPerPeak: WAVEFORM_BASE_SAMPLES_PER_PEAK,
      peaksPerBucket: WAVEFORM_PEAKS_PER_BUCKET,
    });

    const bucket = createBucket(-50);
    waveformCacheService.setBucket("asset-1", 0, 0, bucket);

    expect(waveformCacheService.getCurrentSizeBytes()).toBe(bucket.byteLength);
    expect(waveformCacheService.getMaxSizeBytes()).toBeGreaterThan(bucket.byteLength);
  });
});
