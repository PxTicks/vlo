import type { Point2D } from "./catmullRomUtils";
import type {
  PositionPathParameter,
  ScalarParameter,
  SplineParameter,
  SplinePoint,
} from "../types";
import { isSplineParameter } from "../types";

/**
 * Spline time-inversion primitives.
 *
 * Two flavours of "spline" appear in this codebase:
 *   1. `SplineParameter` — `{time, value}` Hermite splines used for scalar
 *      transformation parameters (position.x/y, scale, rotation, speed,
 *      volume) and the path's normalized timing curve.
 *   2. `PositionPathParameter` — a centripetal Catmull-Rom curve in 2D pixel
 *      space, traversed via a normalized timing spline.
 *
 * For a clip whose source is being reversed, each spline must be reflected so
 * that the resulting playback is the time-inverse of the original. This file
 * isolates that math; the orchestrating logic (which knows about clip stacks,
 * mask trees, and layer-input domains) lives elsewhere.
 */

const TIME_EPSILON = 1e-6;

/**
 * Reflect a {time, value} spline's points around `mirrorTime` on the time
 * axis. Values are preserved. The result is re-sorted ascending by time.
 *
 * Use this for scalar-parameter splines whose input axis is a real time
 * domain (transform-layer input ticks).
 */
export function reflectSplinePointsTime(
  points: readonly SplinePoint[],
  mirrorTime: number,
): SplinePoint[] {
  return [...points]
    .map((p) => ({ time: 2 * mirrorTime - p.time, value: p.value }))
    .sort((a, b) => a.time - b.time);
}

/**
 * Reflect a {time, value} spline's points around `(mirrorTime, mirrorValue)`.
 * Both axes are mirrored. The result is re-sorted ascending by time.
 *
 * Use this for the position-path timing spline whose value axis is also a
 * normalized progress: mirroring both axes preserves monotone-increasing
 * values 0→1 so the spline still describes a valid timing curve.
 */
export function reflectSplinePointsBoth(
  points: readonly SplinePoint[],
  mirrorTime: number,
  mirrorValue: number,
): SplinePoint[] {
  return [...points]
    .map((p) => ({
      time: 2 * mirrorTime - p.time,
      value: 2 * mirrorValue - p.value,
    }))
    .sort((a, b) => a.time - b.time);
}

/**
 * Reflect a `ScalarParameter` on the time axis around `mirrorTime`. Scalars
 * (constant numbers) pass through unchanged.
 */
export function reflectScalarParameterTime(
  param: ScalarParameter | undefined,
  mirrorTime: number,
): ScalarParameter | undefined {
  if (param === undefined || param === null) return param;
  if (typeof param === "number") return param;
  if (!isSplineParameter(param)) return param;
  return {
    type: "spline",
    points: reflectSplinePointsTime(param.points, mirrorTime),
  };
}

/**
 * Reflect a normalized timing spline (time and value in [0,1]) by mirroring
 * both axes around 0.5. The output remains monotone-increasing because
 * (1-v_i) reverses with (1-t_i) symmetrically.
 */
export function reverseNormalizedTimingSpline(
  spline: SplineParameter,
): SplineParameter {
  return {
    type: "spline",
    points: reflectSplinePointsBoth(spline.points, 0.5, 0.5),
  };
}

/**
 * Mirror a set of keyframe times around `mirrorTime`. Re-sorts ascending.
 */
export function reflectKeyframeTimes(
  keyframeTimes: readonly number[] | undefined,
  mirrorTime: number,
): number[] | undefined {
  if (!keyframeTimes || keyframeTimes.length === 0) return keyframeTimes?.slice();
  return [...keyframeTimes]
    .map((t) => 2 * mirrorTime - t)
    .sort((a, b) => a - b);
}

/**
 * Reverse a `PositionPathParameter`.
 *
 * Reversing requires **both** of:
 *   1. Reversing the order of `controlPoints` so that the geometry is
 *      traversed end → start as normalized progress moves 0 → 1.
 *   2. Reflecting the timing spline about (0.5, 0.5) in normalized space —
 *      i.e. mirroring both axes — so its values stay monotone-increasing
 *      0 → 1 while its shape is the time-inverse of the original.
 *
 * Either modification alone is wrong: keeping controlPoints fixed AND
 * mirroring timing in both axes gives the time-inverse of progress *into the
 * same path* (P0 → Pn), which is not the path traversed backwards. Reversing
 * controlPoints alone changes the path direction but uses the original
 * timing curve, which mis-paces non-linear easings.
 *
 * Centripetal Catmull-Rom (`alpha = 0.5`) is geometry-invariant under
 * controlPoint reversal: interior segments share `(p_{i-1}, p_i, p_{i+1},
 * p_{i+2})` neighborhoods after reversal, and the virtual endpoint
 * extrapolation `2·p_0 − p_1` ↔ `2·p_n − p_{n−1}` coincides as well, so the
 * resulting curve is bit-identical to the original traversed backward.
 *
 * The arc-length cache (a WeakMap keyed on `PositionPathParameter`) will
 * naturally repopulate because the reversed object is a fresh reference.
 */
export function reversePositionPath(
  path: PositionPathParameter,
): PositionPathParameter {
  const reversedControlPoints: Point2D[] = [];
  for (let i = path.controlPoints.length - 1; i >= 0; i--) {
    const p = path.controlPoints[i];
    reversedControlPoints.push({ x: p.x, y: p.y });
  }
  return {
    ...path,
    controlPoints: reversedControlPoints,
    timing: reverseNormalizedTimingSpline(path.timing),
  };
}

/**
 * Return true when two spline points are at the same time within epsilon.
 */
export function pointTimeEquals(
  a: SplinePoint,
  b: SplinePoint,
  epsilon: number = TIME_EPSILON,
): boolean {
  return Math.abs(a.time - b.time) <= epsilon;
}
