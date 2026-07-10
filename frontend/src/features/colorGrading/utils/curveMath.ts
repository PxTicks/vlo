import type { ColorCurvePoint } from "../../../core/color";
import { MonotoneCubicSpline } from "../../transformations/utils/MonotoneCubicSpline";
import { PeriodicCubicSpline } from "../../transformations/utils/PeriodicCubicSpline";

export function sanitizeCurvePoints(
  points: readonly ColorCurvePoint[],
  yMin: number,
  yMax: number,
): ColorCurvePoint[] {
  return points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({
      x: Math.max(0, Math.min(1, point.x)),
      y: Math.max(yMin, Math.min(yMax, point.y)),
    }))
    .sort((left, right) => left.x - right.x);
}

export function sampleCurve(
  points: readonly ColorCurvePoint[],
  x: number,
  periodic: boolean,
): number {
  const splinePoints = points.map((point) => ({
    time: point.x,
    value: point.y,
  }));
  return periodic
    ? new PeriodicCubicSpline(splinePoints).at(x)
    : new MonotoneCubicSpline(splinePoints).at(x);
}

export function curvePointFromClient(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  yMin: number,
  yMax: number,
): ColorCurvePoint {
  const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const normalizedY = Math.max(
    0,
    Math.min(1, 1 - (clientY - rect.top) / rect.height),
  );
  return { x, y: yMin + normalizedY * (yMax - yMin) };
}
