import { TICKS_PER_SECOND } from "../constants";

export function getFirstPresentedSampleTicks(
  firstTimestampSeconds?: number | null,
): number {
  if (
    typeof firstTimestampSeconds !== "number" ||
    !Number.isFinite(firstTimestampSeconds) ||
    firstTimestampSeconds <= 0
  ) {
    return 0;
  }

  // Round UP for the same reason as the thumbnail path: a round-to-nearest can
  // floor below the true first sample timestamp, producing a request before the
  // first sample. See getFirstPresentedFrameTicks in thumbnailTiming.ts.
  return Math.ceil(firstTimestampSeconds * TICKS_PER_SECOND);
}

export function clampWaveformAssetTickToFirstSample(
  assetTick: number,
  firstTimestampSeconds?: number | null,
): number {
  return Math.max(assetTick, getFirstPresentedSampleTicks(firstTimestampSeconds));
}

export function resolveWaveformBucketRequestSeconds(
  bucketIndex: number,
  bucketIntervalFrames: number,
  sampleRate: number,
  firstTimestampSeconds?: number | null,
): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return 0;
  }

  const bucketStartTicks = Math.round(
    (bucketIndex * bucketIntervalFrames * TICKS_PER_SECOND) / sampleRate,
  );
  const requestTicks = clampWaveformAssetTickToFirstSample(
    bucketStartTicks,
    firstTimestampSeconds,
  );

  return requestTicks / TICKS_PER_SECOND;
}
