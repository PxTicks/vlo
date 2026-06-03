import type { TimelineClip } from "../../../types/TimelineTypes";
import { clipSourceTimeWindow } from "./clipTimeDomains";

interface LayerDomain {
  minTime: number;
  duration: number;
}

const EMPTY_DOMAIN: LayerDomain = {
  minTime: 0,
  duration: 0,
};

// Fallback when the source-time window collapses (e.g. croppedSourceDuration <= 0).
// Returns ticks to match the primary domain — the full source length, or the
// clip's timeline length as a last resort — so the editor axis never divides by
// a zero-width domain. (Previously returned media *seconds*, a units mismatch.)
function getDomainFallbackDuration(clip: TimelineClip): number {
  return clip.sourceDuration || clip.timelineDuration || 0;
}

/**
 * Resolves the source-media-time data domain for a transform's keyframe graph,
 * with a safe fallback duration when the source-time window collapses.
 *
 * Keyframes are source-anchored, so this is the clip's own source window —
 * independent of the transform's position relative to any speed transform
 * (`transformId` is accepted for call-site compatibility but no longer selects a
 * per-layer domain). The speed-warped *display* axis is applied separately by
 * the spline editor via `buildClipGraphTimeAxis`.
 */
export function getTransformLayerDomain(
  clip: TimelineClip | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  transformId?: string,
): LayerDomain {
  if (!clip) return EMPTY_DOMAIN;

  const { minTime, duration } = clipSourceTimeWindow(clip);

  return {
    minTime,
    duration: duration > 0 ? duration : getDomainFallbackDuration(clip),
  };
}
