import {
  MonotoneCubicSpline,
  type SplinePoint,
} from "./MonotoneCubicSpline";

const POINT_EPSILON = 1e-6;

function wrapUnit(value: number): number {
  return ((value % 1) + 1) % 1;
}

/** A cyclic-domain wrapper around the existing monotone Hermite spline. */
export class PeriodicCubicSpline {
  private readonly spline: MonotoneCubicSpline | null;
  private readonly constantValue: number;

  constructor(points: readonly SplinePoint[]) {
    const sorted = points
      .filter(
        (point) => Number.isFinite(point.time) && Number.isFinite(point.value),
      )
      .map((point) => ({ time: wrapUnit(point.time), value: point.value }))
      .sort((left, right) => left.time - right.time);
    const unique: SplinePoint[] = [];
    for (const point of sorted) {
      const previous = unique[unique.length - 1];
      if (previous && Math.abs(previous.time - point.time) <= POINT_EPSILON) {
        unique[unique.length - 1] = point;
      } else {
        unique.push(point);
      }
    }

    this.constantValue = unique[0]?.value ?? 0;
    if (unique.length < 2) {
      this.spline = null;
      return;
    }

    // Three complete cycles make the middle cycle's seam tangents depend on
    // identical neighbours on both sides, rather than endpoint tangents.
    this.spline = new MonotoneCubicSpline(
      [-1, 0, 1].flatMap((cycle) =>
        unique.map((point) => ({
          time: point.time + cycle,
          value: point.value,
        })),
      ),
    );
  }

  public at(value: number): number {
    return this.spline?.at(wrapUnit(value)) ?? this.constantValue;
  }
}
