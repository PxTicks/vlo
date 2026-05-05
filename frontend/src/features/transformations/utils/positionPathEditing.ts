import type { Point2D } from "./catmullRomUtils";
import { distance, insertControlPointWithIndex } from "./catmullRomUtils";
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
  const result = findNearestControlPointIndexByProgress(points, progress);
  if (result.index < 0 || result.distance > epsilon) {
    return -1;
  }
  return result.index;
}

export function findNearestControlPointIndexByProgress(
  points: Point2D[],
  progress: number,
): { index: number; distance: number } {
  if (points.length === 0) {
    return { index: -1, distance: Number.POSITIVE_INFINITY };
  }

  const normalizedProgress = clamp01(progress);
  const progresses = estimateControlPointProgresses(points);
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  progresses.forEach((candidateProgress, index) => {
    const candidateDistance = Math.abs(candidateProgress - normalizedProgress);
    if (candidateDistance < bestDistance) {
      bestDistance = candidateDistance;
      bestIndex = index;
    }
  });

  return {
    index: bestIndex,
    distance: bestDistance,
  };
}

export interface UpsertPathControlPointResult {
  points: Point2D[];
  index: number;
  inserted: boolean;
}

export function upsertPathControlPointAtProgress(
  path: PositionPathParameter,
  progress: number,
  point: Point2D,
  epsilon: number,
): UpsertPathControlPointResult {
  const normalizedProgress = clamp01(progress);
  const nearestExisting = findNearestControlPointIndexByProgress(
    path.controlPoints,
    normalizedProgress,
  );
  const existingIndex =
    nearestExisting.distance <= epsilon ? nearestExisting.index : -1;

  if (existingIndex >= 0) {
    const nextPoints = [...path.controlPoints];
    nextPoints[existingIndex] = point;
    return {
      points: nextPoints,
      index: existingIndex,
      inserted: false,
    };
  }

  const table = getCachedArcLengthTable(path);
  const insertionResult = insertControlPointWithIndex(
    path.controlPoints,
    table,
    normalizedProgress,
    0.5,
  );
  const nextPoints = [...insertionResult.points];
  nextPoints[insertionResult.index] = point;

  return {
    points: nextPoints,
    index: insertionResult.index,
    inserted: true,
  };
}
