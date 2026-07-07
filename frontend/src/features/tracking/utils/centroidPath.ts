import type { PositionPathParameter } from "../../transformations/types";
import {
  distance,
  processRawDragSamples,
  type RawDragSample,
} from "../../transformations/utils/catmullRomUtils";
import { createDefaultPathTiming } from "../../transformations/utils/positionPathEditing";
import type { CentroidTrackingSample } from "../types";

export interface CentroidTrackingPathOptions {
  spatialEpsilon?: number;
  simplifyEpsilon?: number;
  minMotion?: number;
}

function isFiniteSample(sample: CentroidTrackingSample): boolean {
  return (
    Number.isFinite(sample.time) &&
    Number.isFinite(sample.position.x) &&
    Number.isFinite(sample.position.y) &&
    Number.isFinite(sample.centroid.x) &&
    Number.isFinite(sample.centroid.y)
  );
}

function normalizeSamples(
  samples: readonly CentroidTrackingSample[],
): CentroidTrackingSample[] {
  return samples
    .filter(isFiniteSample)
    .map((sample) => ({
      time: sample.time,
      position: { ...sample.position },
      centroid: { ...sample.centroid },
    }))
    .sort((left, right) => left.time - right.time);
}

function hasMeaningfulMotion(
  samples: readonly RawDragSample[],
  minMotion: number,
): boolean {
  if (samples.length < 2) return false;
  const firstPoint = samples[0].point;
  return samples.some((sample) => distance(firstPoint, sample.point) >= minMotion);
}

export function createCentroidStabilizedPath(
  samples: readonly CentroidTrackingSample[],
  options: CentroidTrackingPathOptions = {},
): PositionPathParameter | null {
  const orderedSamples = normalizeSamples(samples);
  if (orderedSamples.length < 2) {
    return null;
  }

  const anchorCentroid = orderedSamples[0].centroid;
  const pathSamples: RawDragSample[] = orderedSamples.map((sample) => ({
    time: sample.time,
    point: {
      x: sample.position.x + anchorCentroid.x - sample.centroid.x,
      y: sample.position.y + anchorCentroid.y - sample.centroid.y,
    },
  }));

  if (!hasMeaningfulMotion(pathSamples, options.minMotion ?? 0.5)) {
    return null;
  }

  const processed = processRawDragSamples(
    pathSamples,
    options.spatialEpsilon ?? 2,
    options.simplifyEpsilon ?? 1,
  );
  if (processed.points.length < 2) {
    return null;
  }

  const defaultTiming = createDefaultPathTiming();
  const timingPoints =
    processed.timingSplinePoints.length >= 2
      ? processed.timingSplinePoints
      : defaultTiming.points;

  return {
    type: "path2d",
    curve: "centripetal_catmull_rom",
    controlPoints: processed.points,
    timing: {
      type: "spline",
      points: timingPoints,
    },
  };
}
