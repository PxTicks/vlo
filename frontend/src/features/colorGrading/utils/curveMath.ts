import {
  createColorCurveSampler,
  type ColorCurvePoint,
  type ColorCurveSampler,
} from "../../../core/color";

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
  return createCurveEvaluator(points, periodic).at(x);
}

export function createCurveEvaluator(
  points: readonly ColorCurvePoint[],
  periodic: boolean,
): ColorCurveSampler {
  return createColorCurveSampler(points, periodic);
}

export function clampCurvePointX(
  points: readonly ColorCurvePoint[],
  index: number,
  nextX: number,
): number {
  const lowerBound = index > 0 ? points[index - 1].x + 0.0001 : 0;
  const upperBound =
    index < points.length - 1 ? points[index + 1].x - 0.0001 : 1;
  return Math.max(lowerBound, Math.min(upperBound, nextX));
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
