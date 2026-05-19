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
 * Reverse a `PositionPathParameter`. The path's geometry is held fixed and
 * the timing curve is mirrored — at normalized time 0 we now sample the end
 * of the path, at 1 the start, with the same intermediate timing shape
 * (modulo reflection). This avoids re-running Catmull-Rom arc-length tables.
 */
export function reversePositionPath(
  path: PositionPathParameter,
): PositionPathParameter {
  return {
    ...path,
    controlPoints: path.controlPoints.map<Point2D>((p) => ({ x: p.x, y: p.y })),
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
