import type { TimelineClip } from "../../../types/TimelineTypes";

export function sortTrackClipsByStart(trackClips: TimelineClip[]): TimelineClip[] {
  if (trackClips.length <= 1) return trackClips;
  return [...trackClips].sort(
    (left, right) => left.start - right.start || left.id.localeCompare(right.id),
  );
}

/**
 * Finds the active clip at `targetTicks`.
 * Expects clips sorted by `start` in ascending order.
 */
export function findActiveClipAtTicks(
  trackClips: TimelineClip[],
  targetTicks: number,
): TimelineClip | undefined {
  const searchableClips = trackClips.some((clip) => clip.type === "mask")
    ? trackClips.filter((clip) => clip.type !== "mask")
    : trackClips;

  let low = 0;
  let high = searchableClips.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const clip = searchableClips[mid];
    const clipEnd = clip.start + clip.timelineDuration;

    if (targetTicks < clip.start) {
      high = mid - 1;
      continue;
    }
    if (targetTicks >= clipEnd) {
      low = mid + 1;
      continue;
    }
    return clip;
  }

  return undefined;
}
