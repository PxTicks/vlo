import type { ArcLengthEntry } from "./catmullRomUtils";
import { generateArcLengthTable } from "./catmullRomUtils";
import type { Point2D } from "./catmullRomUtils";
import type {
  PositionPathParameter,
  SpatialPathParameter,
} from "../types";
import { isExtensionSpatialPathParameter } from "../types";
import type { ExtensionCompiledSpatialPath } from "../../extensions/types";
import {
  CORE_CATMULL_ROM_PATH_ID,
  extensionSpatialPathRegistry,
} from "../animation";
import { resolveScalar } from "./resolveScalar";

const DEFAULT_SAMPLES_PER_SEGMENT = 24;

const arcLengthTableCache = new WeakMap<PositionPathParameter, ArcLengthEntry[]>();
const compiledPathCache = new Map<string, ExtensionCompiledSpatialPath>();
const COMPILED_PATH_CACHE_CAPACITY = 128;

extensionSpatialPathRegistry.subscribe(() => {
  compiledPathCache.forEach((compiled) => compiled.dispose());
  compiledPathCache.clear();
});

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
  path: SpatialPathParameter,
  visualTime: number,
  visualDuration: number,
): number {
  const normalizedTime =
    visualDuration > 0 ? clamp01(visualTime / visualDuration) : 0;
  return clamp01(resolveScalar(path.timing, normalizedTime, normalizedTime));
}

function corePathPayload(path: PositionPathParameter) {
  const separator = CORE_CATMULL_ROM_PATH_ID.indexOf("/");
  return {
    extensionId: CORE_CATMULL_ROM_PATH_ID.slice(0, separator),
    typeId: CORE_CATMULL_ROM_PATH_ID.slice(separator + 1),
    schemaVersion: 1,
    data: path.controlPoints.map(({ x, y }) => ({ x, y })),
  } as const;
}

function getCompiledPath(path: SpatialPathParameter): ExtensionCompiledSpatialPath {
  const key = JSON.stringify(path);
  const cached = compiledPathCache.get(key);
  if (cached) {
    compiledPathCache.delete(key);
    compiledPathCache.set(key, cached);
    return cached;
  }
  const payload = isExtensionSpatialPathParameter(path)
    ? path.geometry
    : corePathPayload(path);
  const compiled = extensionSpatialPathRegistry.compile(payload);
  compiledPathCache.set(key, compiled);
  while (compiledPathCache.size > COMPILED_PATH_CACHE_CAPACITY) {
    const oldestKey = compiledPathCache.keys().next().value;
    if (oldestKey === undefined) break;
    compiledPathCache.get(oldestKey)?.dispose();
    compiledPathCache.delete(oldestKey);
  }
  return compiled;
}

export function samplePositionPath(
  path: SpatialPathParameter,
  visualTime: number,
  visualDuration: number,
): Point2D {
  const progress = resolvePositionPathProgress(path, visualTime, visualDuration);
  try {
    return getCompiledPath(path).pointAt(progress);
  } catch {
    return { x: 0, y: 0 };
  }
}
