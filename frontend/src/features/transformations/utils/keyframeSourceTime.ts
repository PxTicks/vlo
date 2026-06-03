import type { TimelineClip } from "../../../types/TimelineTypes";
import {
  calculateClipTime,
  mapSourceTimeToVisualTime,
} from "./timeCalculation";

/**
 * Source-time keyframe anchoring — the single seam for the rule:
 *
 *   Keyframe times are ALWAYS stored in absolute source ticks, independent of
 *   where any speed transform sits in the stack.
 *
 * Speed is treated purely as a visual<->source clock remap: it changes *when* a
 * source frame is presented, never *what* that frame's transform values are. A
 * frame that is a certain colour/position stays that colour/position; speed only
 * reschedules it. Keeping the whole convention here means it can be toggled,
 * revisited, or reverted in one place rather than chased across the codebase.
 *
 * All four helpers are thin wrappers over the existing `timeCalculation`
 * primitives, which already compose the *entire* speed stack (multiple speeds,
 * ramps) — see `pullTimeThroughTransforms` / `pushTimeThroughTransforms`. So
 * stacking stays well-defined; we only stop letting a transform's *position*
 * relative to speed decide its time domain.
 */

/**
 * Convert a clip-local visual tick (e.g. the playhead, relative to the clip's
 * visual start) to the absolute source tick a keyframe should be stored/sampled
 * at. Pulls through the clip's full speed stack.
 */
export function getSourceKeyframeTime(
  clip: TimelineClip,
  localVisualTicks: number,
): number {
  return calculateClipTime(clip, localVisualTicks, true);
}

/**
 * Inverse of {@link getSourceKeyframeTime}: map a stored source tick back to
 * clip-local visual time (for placing timeline markers). Pushes through the full
 * speed stack.
 */
export function getKeyframeVisualTime(
  clip: TimelineClip,
  sourceTicks: number,
): number {
  return mapSourceTimeToVisualTime(clip, sourceTicks);
}

/**
 * The source-tick window a clip's keyframes live in. Doubles as the spline
 * editor's *data* domain (linear, source-native), over which endpoint-locking
 * and clamping operate.
 */
export function getSourceKeyframeDomain(clip: TimelineClip): {
  minTime: number;
  duration: number;
} {
  return {
    minTime: clip.offset,
    duration: Math.max(0, clip.croppedSourceDuration || 0),
  };
}

/**
 * A spline-editor X axis. The graph keeps its point data in source ticks
 * (`sourceMin`..`sourceMin + sourceDuration`) and maps to/from a normalized
 * `[0, 1]` screen position through `sourceToNorm` / `normToSource`. The mapping
 * is linear when there is no speed (or a single constant factor) and curves
 * under a speed ramp — that curvature is the "warped axis" we want, applied as a
 * pure rendering transform without ever moving the stored source times.
 */
export interface GraphTimeAxis {
  sourceMin: number;
  sourceDuration: number;
  /** Source tick -> normalized [0, 1] position along the (possibly warped) axis. */
  sourceToNorm(sourceTick: number): number;
  /** Normalized [0, 1] position -> source tick. */
  normToSource(norm: number): number;
}

/**
 * Build the warped axis for a *value* transform on `clip`, using the clip's OWN
 * speed stack only (adjustment-layer speed is intentionally excluded — the panel
 * shows the clip-local domain). The speed transform's own factor graph must NOT
 * use this (it would self-warp); give it {@link buildLinearGraphTimeAxis}.
 */
export function buildClipGraphTimeAxis(clip: TimelineClip): GraphTimeAxis {
  const { minTime: sourceMin, duration: sourceDuration } =
    getSourceKeyframeDomain(clip);
  const sourceMax = sourceMin + sourceDuration;

  // Visual (clip-local) bounds of the source window. `visSpan` guards against a
  // zero-length window collapsing the normalization.
  const visMin = mapSourceTimeToVisualTime(clip, sourceMin);
  const visMax = mapSourceTimeToVisualTime(clip, sourceMax);
  const visSpan = visMax - visMin || 1;

  return {
    sourceMin,
    sourceDuration,
    sourceToNorm: (sourceTick) =>
      (mapSourceTimeToVisualTime(clip, sourceTick) - visMin) / visSpan,
    normToSource: (norm) =>
      calculateClipTime(clip, visMin + norm * visSpan, true),
  };
}

/**
 * Linear, un-warped axis over a source window. Used for the speed factor graph
 * (authored in source time) and as the backtrack/fallback path.
 */
export function buildLinearGraphTimeAxis(
  minTime: number,
  duration: number,
): GraphTimeAxis {
  const span = duration || 1;
  return {
    sourceMin: minTime,
    sourceDuration: duration,
    sourceToNorm: (t) => (t - minTime) / span,
    normToSource: (norm) => minTime + norm * span,
  };
}
