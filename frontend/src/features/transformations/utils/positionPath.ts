import type { ArcLengthEntry } from "./catmullRomUtils";
import { generateArcLengthTable, samplePathAtProgress } from "./catmullRomUtils";
import type { Point2D } from "./catmullRomUtils";
import type { PositionPathParameter } from "../types";
import { resolveScalar } from "./resolveScalar";

const DEFAULT_SAMPLES_PER_SEGMENT = 24;

const arcLengthTableCache = new WeakMap<PositionPathParameter, ArcLengthEntry[]>();

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function getCachedArcLengthTable(
  path: PositionPathParameter,
): ArcLengthEntry[] {
  const cached = arcLengthTableCache.get(path);
  if (cached) {
    return cached;
  }

  const table = generateArcLengthTable(
    path.controlPoints,
    DEFAULT_SAMPLES_PER_SEGMENT,
    0.5,
  );
  arcLengthTableCache.set(path, table);
  return table;
}

export function resolvePositionPathProgress(
  path: PositionPathParameter,
  visualTime: number,
  visualDuration: number,
): number {
  const normalizedTime =
    visualDuration > 0 ? clamp01(visualTime / visualDuration) : 0;
  return clamp01(resolveScalar(path.timing, normalizedTime, normalizedTime));
}

export function samplePositionPath(
  path: PositionPathParameter,
  visualTime: number,
  visualDuration: number,
): Point2D {
  const progress = resolvePositionPathProgress(path, visualTime, visualDuration);
  const table = getCachedArcLengthTable(path);
  return samplePathAtProgress(path.controlPoints, table, progress, 0.5);
}
