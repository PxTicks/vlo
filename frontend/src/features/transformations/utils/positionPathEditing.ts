import type { Point2D } from "./catmullRomUtils";
import { distance, insertControlPoint } from "./catmullRomUtils";
import type { PositionPathParameter } from "../types";
import { getCachedArcLengthTable } from "./positionPath";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function createDefaultPathTiming() {
  return {
    type: "spline" as const,
    points: [
      { time: 0, value: 0 },
      { time: 1, value: 1 },
    ],
  };
}

export function estimateControlPointProgresses(points: Point2D[]): number[] {
  if (points.length === 0) {
    return [];
  }
  if (points.length === 1) {
    return [0];
  }

  const lengths = [0];
  let totalLength = 0;

  for (let index = 1; index < points.length; index += 1) {
    totalLength += distance(points[index - 1], points[index]);
    lengths.push(totalLength);
  }

  if (totalLength <= 0) {
    return points.map((_point, index) => index / (points.length - 1));
  }

  return lengths.map((length) => length / totalLength);
}

export function findControlPointIndexNearProgress(
  points: Point2D[],
  progress: number,
  epsilon: number,
): number {
  if (points.length === 0) {
    return -1;
  }

  const normalizedProgress = clamp01(progress);
  const progresses = estimateControlPointProgresses(points);
  return progresses.findIndex(
    (candidateProgress) =>
      Math.abs(candidateProgress - normalizedProgress) <= epsilon,
  );
}

export function upsertPathControlPointAtProgress(
  path: PositionPathParameter,
  progress: number,
  point: Point2D,
  epsilon: number,
): Point2D[] {
  const normalizedProgress = clamp01(progress);
  const existingIndex = findControlPointIndexNearProgress(
    path.controlPoints,
    normalizedProgress,
    epsilon,
  );

  if (existingIndex >= 0) {
    const nextPoints = [...path.controlPoints];
    nextPoints[existingIndex] = point;
    return nextPoints;
  }

  const table = getCachedArcLengthTable(path);
  const nextPoints = insertControlPoint(
    path.controlPoints,
    table,
    normalizedProgress,
    0.5,
  );
  const insertedIndex = findControlPointIndexNearProgress(
    nextPoints,
    normalizedProgress,
    epsilon * 2,
  );

  if (insertedIndex >= 0) {
    nextPoints[insertedIndex] = point;
  }

  return nextPoints;
}
