import { TICKS_PER_SECOND } from "../constants";

export function getFirstPresentedFrameTicks(
  firstTimestampSeconds?: number | null,
): number {
  if (
    typeof firstTimestampSeconds !== "number" ||
    !Number.isFinite(firstTimestampSeconds) ||
    firstTimestampSeconds <= 0
  ) {
    return 0;
  }

  return Math.round(firstTimestampSeconds * TICKS_PER_SECOND);
}

export function clampThumbnailAssetTickToFirstFrame(
  assetTick: number,
  firstTimestampSeconds?: number | null,
): number {
  return Math.max(assetTick, getFirstPresentedFrameTicks(firstTimestampSeconds));
}

export function resolveThumbnailBucketRequestSeconds(
  bucketIndex: number,
  bucketIntervalTicks: number,
  firstTimestampSeconds?: number | null,
): number {
  const bucketStartTicks = bucketIndex * bucketIntervalTicks;
  const requestTicks = clampThumbnailAssetTickToFirstFrame(
    bucketStartTicks,
    firstTimestampSeconds,
  );

  return requestTicks / TICKS_PER_SECOND;
}
