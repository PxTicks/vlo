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

  // Round UP so the resulting tick (and the seconds we derive from it for the
  // sample request) never lands *before* the real first frame. A round-to-
  // nearest can floor below the true timestamp — e.g. a proxy re-encoded at a
  // 1/57600 timebase puts its first frame at 0.4686285s -> 44988.33 ticks ->
  // round() = 44988 -> 0.468625s, which is before the frame, so mediabunny
  // returns null and the first thumbnail slot renders blank.
  return Math.ceil(firstTimestampSeconds * TICKS_PER_SECOND);
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
