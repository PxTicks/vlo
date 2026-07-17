import {
  mediaTimestampToFirstAvailableTick,
  tickToMediaSeconds,
} from "../../renderer/utils/mediaTime";

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
  return mediaTimestampToFirstAvailableTick(firstTimestampSeconds);
}

export function clampThumbnailAssetTickToFirstFrame(
  assetTick: number,
  firstTimestampSeconds?: number | null,
): number {
  return Math.max(
    assetTick,
    getFirstPresentedFrameTicks(firstTimestampSeconds),
  );
}

export function resolveThumbnailBucketRequestSeconds(
  bucketIndex: number,
  bucketIntervalTicks: number,
  firstTimestampSeconds?: number | null,
  sourceDurationTicks?: number | null,
): number {
  const bucketStartTicks = bucketIndex * bucketIntervalTicks;
  const representativeTick =
    bucketStartTicks + Math.max(0, bucketIntervalTicks / 2);
  const lastSourceTick =
    typeof sourceDurationTicks === "number" &&
    Number.isFinite(sourceDurationTicks) &&
    sourceDurationTicks > 0
      ? Math.max(0, sourceDurationTicks - 1)
      : Number.POSITIVE_INFINITY;
  const requestTicks = clampThumbnailAssetTickToFirstFrame(
    Math.min(representativeTick, lastSourceTick),
    firstTimestampSeconds,
  );

  return tickToMediaSeconds(requestTicks);
}
