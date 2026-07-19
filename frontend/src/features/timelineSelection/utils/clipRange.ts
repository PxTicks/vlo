import type { TimelineClip } from "../../../types/TimelineTypes";
import { getSegmentContentDuration } from "../../transformations/utils/timeCalculation";

/**
 * Crop a clip using offsets in its stored track-time domain. Source offsets
 * and transformed crop fields follow interactive clip trimming.
 */
export function cropTimelineClipToOffsets<T extends TimelineClip>(
  clip: T,
  startOffset: number,
  endOffset: number,
): T | null {
  const boundedStart = Math.max(0, Math.min(clip.timelineDuration, startOffset));
  const boundedEnd = Math.max(0, Math.min(clip.timelineDuration, endOffset));
  if (boundedStart >= boundedEnd) {
    return null;
  }

  const cropped = structuredClone(clip);
  const leftDelta = boundedStart;
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
      start: clip.start + leftDelta,
      timelineDuration,
      offset,
      transformedOffset,
      croppedSourceDuration,
    });
  }

  const duration = boundedEnd - boundedStart;
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
