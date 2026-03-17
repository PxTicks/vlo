import { isSplineParameter, type SplineParameter } from "../types";

const POINT_EPSILON_TICKS = 1;

/**
 * Insert or update a spline point at `time`.
 * If a point already exists within `epsilon` ticks, its value is overwritten.
 * If `param` is not yet a spline (scalar or undefined), a new single-point spline is created.
 */
export function upsertSplinePoint(
  param: unknown,
  time: number,
  value: number,
  epsilon: number = POINT_EPSILON_TICKS,
): SplineParameter {
  const current = isSplineParameter(param) ? param : null;
  const points = current ? [...current.points] : [];
  const existingIndex = points.findIndex(
    (p) => Math.abs(p.time - time) <= epsilon,
  );

  if (existingIndex >= 0) {
    points[existingIndex] = { ...points[existingIndex], value };
  } else {
    points.push({ time, value });
  }

  points.sort((a, b) => a.time - b.time);
  return { type: "spline", points };
}

/**
 * If a spline has >1 points and all share the same value, collapse it to a scalar.
 * Single-point splines (≤1 points) are left as-is.
 */
export function collapseConstantSpline(param: unknown): unknown {
  if (!isSplineParameter(param) || param.points.length <= 1) return param;
  const first = param.points[0]?.value;
  const isConstant = param.points.every(
    (p) => Math.abs(p.value - first) < 1e-9,
  );
  return isConstant ? first : param;
}

/**
 * Remove the spline point nearest to `time` (within `epsilon` ticks) and return the
 * remaining spline. Returns `param` unchanged if it is not a SplineParameter.
 *
 * The caller is responsible for applying `collapseConstantSpline` or resetting to a
 * default scalar when appropriate (e.g. when keyframeTimes becomes empty).
 */
export function removeSplinePoint(
  param: unknown,
  time: number,
  epsilon: number = POINT_EPSILON_TICKS,
): unknown {
  if (!isSplineParameter(param)) return param;
  const points = param.points.filter(
    (p) => Math.abs(p.time - time) > epsilon,
  );
  return { type: "spline" as const, points };
}

/**
 * Transition a constant scalar parameter to a SplineParameter by placing explicit
 * points at every `keyframeTimes` entry (all with `scalarValue`), then upsert the
 * diverging point at `newTime` with `newValue`.
 *
 * Used when the "constant shortcut" is broken: a control that was scalar now has a
 * differing value at one keyframe time, so all keyframe times must become explicit
 * spline points.
 */
export function materializeFromScalar(
  scalarValue: number,
  keyframeTimes: number[],
  newTime: number,
  newValue: number,
  epsilon: number = POINT_EPSILON_TICKS,
): SplineParameter {
  const allTimes = new Set(keyframeTimes);
  allTimes.add(newTime);
  const points = Array.from(allTimes)
    .sort((a, b) => a - b)
    .map((t) => ({
      time: t,
      value: Math.abs(t - newTime) <= epsilon ? newValue : scalarValue,
    }));
  return { type: "spline" as const, points };
}

/**
 * Returns times that were explicitly added/removed between two spline point arrays.
 * Points matched within `epsilon` are treated as the same point.
 */
export function diffSplinePointTimes(
  previousPoints: Array<{ time: number; value: number }>,
  nextPoints: Array<{ time: number; value: number }>,
  epsilon: number = POINT_EPSILON_TICKS,
): { addedTimes: number[]; removedTimes: number[] } {
  const previousMatched = new Array(previousPoints.length).fill(false);
  const nextMatched = new Array(nextPoints.length).fill(false);

  // Greedy nearest-time matching within epsilon.
  for (let prevIdx = 0; prevIdx < previousPoints.length; prevIdx++) {
    let bestNextIdx = -1;
    let bestDistance = Infinity;

    for (let nextIdx = 0; nextIdx < nextPoints.length; nextIdx++) {
      if (nextMatched[nextIdx]) continue;

      const distance = Math.abs(
        previousPoints[prevIdx].time - nextPoints[nextIdx].time,
      );
      if (distance <= epsilon && distance < bestDistance) {
        bestDistance = distance;
        bestNextIdx = nextIdx;
      }
    }

    if (bestNextIdx !== -1) {
      previousMatched[prevIdx] = true;
      nextMatched[bestNextIdx] = true;
    }
  }

  const removedTimes = previousPoints
    .filter((_, idx) => !previousMatched[idx])
    .map((point) => point.time);

  const addedTimes = nextPoints
    .filter((_, idx) => !nextMatched[idx])
    .map((point) => point.time);

  return { addedTimes, removedTimes };
}

/**
 * True when `param` is a spline with an explicit point at `time` (within `epsilon`).
 */
export function hasExplicitSplinePointAtTime(
  param: unknown,
  time: number,
  epsilon: number = POINT_EPSILON_TICKS,
): boolean {
  if (!isSplineParameter(param)) return false;
  return param.points.some((point) => Math.abs(point.time - time) <= epsilon);
}
