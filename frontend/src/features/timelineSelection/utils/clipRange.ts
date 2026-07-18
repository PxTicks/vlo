import type { TimelineClip } from "../../../types/TimelineTypes";
import { getSegmentContentDuration } from "../../transformations/utils/timeCalculation";

/**
 * Returns an isolated copy of the portion of a clip inside a timeline range.
 * Source offsets and transformed crop fields follow the same calculations as
 * interactive left/right clip trimming.
 */
export function cropTimelineClipToRange<T extends TimelineClip>(
  clip: T,
  rangeStart: number,
  rangeEnd: number,
): T | null {
  const intersectionStart = Math.max(clip.start, rangeStart);
  const intersectionEnd = Math.min(
    clip.start + clip.timelineDuration,
    rangeEnd,
  );
  if (intersectionStart >= intersectionEnd) {
    return null;
  }

  const cropped = structuredClone(clip);
  const leftDelta = intersectionStart - cropped.start;
  if (leftDelta > 0) {
    const transformedOffset = (cropped.transformedOffset ?? 0) + leftDelta;
    const timelineDuration = cropped.timelineDuration - leftDelta;
    const offset =
      cropped.offset + getSegmentContentDuration(cropped, 0, leftDelta);
    const croppedSourceDuration = getSegmentContentDuration(
      cropped,
      transformedOffset,
      timelineDuration,
    );
    Object.assign(cropped, {
      start: intersectionStart,
      timelineDuration,
      offset,
      transformedOffset,
      croppedSourceDuration,
    });
  }

  const duration = intersectionEnd - cropped.start;
  if (duration < cropped.timelineDuration) {
    cropped.timelineDuration = duration;
    cropped.croppedSourceDuration = getSegmentContentDuration(
      cropped,
      cropped.transformedOffset ?? 0,
      duration,
    );
  }

  return cropped;
}
