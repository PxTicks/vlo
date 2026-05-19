import type {
  ClipMaskPoint,
  MaskActiveRange,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import { reverseTransformationStack } from "../../transformations/utils/reverseTransformations";

/**
 * Mask-side reversal helpers.
 *
 * Masks attach to a parent clip and inherit its timing window. The handful of
 * fields that live in mask-local time domains (point timestamps, active-range
 * bounds, and the mask's own transform stack) must be flipped when the parent
 * clip is reversed so the mask continues to track the same content.
 *
 * All time-bearing fields here are in source-tick domain on the parent clip's
 * asset (pre-reversal). After reversal the parent has been swapped onto a new
 * reversed asset of identical duration, so we simply reflect around
 * `sourceDuration / 2`.
 */

export function reverseMaskActiveRange(
  range: MaskActiveRange,
  sourceDurationTicks: number,
): MaskActiveRange {
  const nextStart = sourceDurationTicks - range.endSourceTicks;
  const nextEnd = sourceDurationTicks - range.startSourceTicks;
  return {
    startSourceTicks: Math.min(nextStart, nextEnd),
    endSourceTicks: Math.max(nextStart, nextEnd),
  };
}

export function reverseMaskPoints(
  points: readonly ClipMaskPoint[],
  sourceDurationTicks: number,
): ClipMaskPoint[] {
  return points
    .map<ClipMaskPoint>((point) => ({
      ...point,
      timeTicks: sourceDurationTicks - point.timeTicks,
    }))
    .sort((a, b) => a.timeTicks - b.timeTicks);
}

/**
 * Apply reversal to every time-bearing field of a `MaskTimelineClip`.
 *
 * The caller is responsible for syncing the parent timing fields onto the
 * mask afterwards (e.g. via the existing `syncMaskTiming` in maskClipModel),
 * since `offset`/`croppedSourceDuration` change on the parent.
 */
export function reverseMaskTimelineClip(
  mask: MaskTimelineClip,
  sourceDurationTicks: number,
): MaskTimelineClip {
  const next: MaskTimelineClip = { ...mask };

  if (mask.activeRange) {
    next.activeRange = reverseMaskActiveRange(
      mask.activeRange,
      sourceDurationTicks,
    );
  }

  if (mask.maskPoints && mask.maskPoints.length > 0) {
    next.maskPoints = reverseMaskPoints(mask.maskPoints, sourceDurationTicks);
    // SAM2's `isSam2Dirty` check compares the points hash against the stored
    // `sam2GeneratedPointsHash`; reversing the points changes the hash and
    // automatically marks the mask as needing regeneration, so we don't touch
    // the cache fields here.
  }

  return next;
}

/**
 * Reverse the inline transform stack carried by a `ClipMask` (legacy /
 * non-promoted mask attached via components). Returns the next array.
 */
export function reverseClipMaskTransformations(
  transformations: ClipMask_TransformsLike | undefined,
  sourceDurationTicks: number,
): ClipMask_TransformsLike {
  if (!transformations || transformations.length === 0) {
    return transformations ?? [];
  }
  return reverseTransformationStack(transformations, sourceDurationTicks);
}

// Local alias to avoid a cyclic type dependency: ClipMask.transformations
// is typed as ClipTransform[] in TimelineTypes.
type ClipMask_TransformsLike = import("../../../types/TimelineTypes").ClipTransform[];
