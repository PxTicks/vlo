import type { TimelineClip } from "../../../types/TimelineTypes";
import { getSegmentContentDuration } from "../../transformations";

/**
 * Calculates new clip properties when resizing from the LEFT edge.
 *
 * @param clip The original clip
 * @param deltaTicks Validated change in start time (in ticks). Positive = shrink, Negative = grow.
 */
export function getResizedClipLeft(
  clip: TimelineClip,
  deltaTicks: number,
): Partial<TimelineClip> {
  const newStart = clip.start + deltaTicks;

  // Calculate how much source time corresponds to this visual delta
  const offsetDelta = getSegmentContentDuration(clip, 0, deltaTicks);

  const newStartCrop = (clip.transformedOffset ?? 0) + deltaTicks;
  const newDuration = clip.timelineDuration - deltaTicks;

  return {
    start: newStart,
    timelineDuration: newDuration,
    offset: clip.offset + offsetDelta, // Generalized for splines/stacking
    transformedOffset: newStartCrop,
    croppedSourceDuration: getSegmentContentDuration(
      clip,
      newStartCrop,
      newDuration,
    ),
  };
}

/**
 * Calculates new clip properties when resizing from the RIGHT edge.
 *
 * @param clip The original clip
 * @param deltaTicks Validated change in end time (in ticks). Positive = grow, Negative = shrink.
 */
export function getResizedClipRight(
  clip: TimelineClip,
  deltaTicks: number,
): Partial<TimelineClip> {
  const newEnd = clip.start + clip.timelineDuration + deltaTicks;
  const newDuration = newEnd - clip.start;

  return {
    timelineDuration: newDuration,
    croppedSourceDuration: getSegmentContentDuration(
      clip,
      clip.transformedOffset ?? 0,
      newDuration,
    ),
  };
}
