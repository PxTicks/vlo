/**
 * Before/after numerical parity harness for the extension-animation refactor.
 *
 * The refactor re-routes the CORE animation path through the new extension
 * registries: legacy `SplineParameter` scalar resolution, position-path
 * geometry, and speed-ramp time inversion are all now compiled through
 * `vlo.core/*` providers + an LRU compile cache instead of bespoke inline math.
 *
 * Because that path drives every keyframed transform in every existing project,
 * this file pins the NEW public functions against references copied VERBATIM
 * from the pre-refactor implementation (git HEAD at the time of the refactor):
 *
 *   - resolveScalar (spline branch) ......... new MonotoneCubicSpline(points).at(time)
 *   - samplePositionPath (geometry) ......... samplePathAtProgress(points,
 *                                              generateArcLengthTable(points, 24, 0.5), p, 0.5)
 *   - getIdempotentTimeMap (speed) .......... createInverseSpeedSpline(points).at(t, extrapolate)
 *
 * The references use the SAME unchanged primitives the old code used, so a
 * passing run proves the new routing/caching/segment-dispatch layer is
 * numerically transparent. Any divergence above EPSILON is a real regression
 * in the core animation path and the failure message reports the worst point.
 */

import { describe, expect, it } from "vitest";
import { MonotoneCubicSpline } from "../MonotoneCubicSpline";
import {
  generateArcLengthTable,
  samplePathAtProgress,
} from "../catmullRomUtils";
import { TICKS_PER_SECOND } from "../../../../core/time/constants";
import { resolveScalar } from "../resolveScalar";
import { getIdempotentTimeMap } from "../timeCalculation";
import { samplePositionPath } from "../positionPath";
import type { SplineParameter, SpatialPathParameter } from "../types";

// Tight enough to catch routing/segmentation drift; loose enough to ignore
// last-bit float reassociation. The shared primitives make exact agreement the
// expectation, so this margin should never actually be consumed.
const EPSILON = 1e-9;

interface Point2D {
  x: number;
  y: number;
}

type SplinePoint = { time: number; value: number };

// --- VERBATIM HEAD REFERENCES ------------------------------------------------
// Copied from the pre-refactor utils. Do not "simplify" — these must reproduce
// the old behavior exactly, including the integration density and clamps.

const DEFAULT_SAMPLES_PER_SEGMENT = 24; // old positionPath.ts
const PATH_ALPHA = 0.5; // old centripetal Catmull-Rom alpha

function oldResolveSpline(points: SplinePoint[], time: number): number {
  return new MonotoneCubicSpline(points).at(time);
}

function oldSamplePath(controlPoints: Point2D[], progress: number): Point2D {
  const table = generateArcLengthTable(
    controlPoints,
    DEFAULT_SAMPLES_PER_SEGMENT,
    PATH_ALPHA,
  );
  return samplePathAtProgress(controlPoints, table, progress, PATH_ALPHA);
}

// Verbatim from old timeCalculation.ts createInverseSpeedSpline.
function oldCreateInverseSpeedSpline(points: SplinePoint[]): MonotoneCubicSpline {
  const speedSpline = new MonotoneCubicSpline(points);
  const maxSourceTime = points[points.length - 1].time;
  const INTEGRATION_SAMPLES_PER_SEC = 5;
  const durationSeconds = maxSourceTime / TICKS_PER_SECOND;
  const steps = Math.max(
    100,
    Math.ceil(durationSeconds * INTEGRATION_SAMPLES_PER_SEC),
  );

  const reversePoints: SplinePoint[] = [];
  let currentTimelineTime = 0;
  let prevSourceTime = 0;
  reversePoints.push({ time: 0, value: 0 });

  for (let i = 1; i <= steps; i++) {
    const tSource = (i / steps) * maxSourceTime;
    const dt = tSource - prevSourceTime;
    const midT = prevSourceTime + dt / 2;
    const speed = Math.max(0.01, speedSpline.at(midT));
    const dTimeline = dt / speed;
    currentTimelineTime += dTimeline;
    reversePoints.push({ time: currentTimelineTime, value: tSource });
    prevSourceTime = tSource;
  }
  return new MonotoneCubicSpline(reversePoints);
}

function oldIdempotentTimeMap(
  points: SplinePoint[],
  outputTime: number,
  extrapolate: boolean,
): number {
  return oldCreateInverseSpeedSpline(points).at(outputTime, extrapolate);
}

// --- HELPERS -----------------------------------------------------------------

interface Divergence {
  max: number;
  atInput: string;
}

function trackMax(
  current: Divergence,
  diff: number,
  describe: () => string,
): Divergence {
  if (diff > current.max) return { max: diff, atInput: describe() };
  return current;
}

function linspace(from: number, to: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) =>
    from + ((to - from) * i) / (count - 1),
  );
}

function spline(points: SplinePoint[]): SplineParameter {
  return { type: "spline", points } as SplineParameter;
}

// --- FIXTURES ----------------------------------------------------------------

const SCALAR_BATTERY: { name: string; points: SplinePoint[] }[] = [
  { name: "two-point linear", points: [{ time: 0, value: 0 }, { time: 100, value: 50 }] },
  {
    name: "three-point ease",
    points: [
      { time: 0, value: 10 },
      { time: 50, value: 80 },
      { time: 120, value: 30 },
    ],
  },
  {
    name: "non-monotonic values",
    points: [
      { time: 0, value: 0 },
      { time: 30, value: 100 },
      { time: 60, value: -40 },
      { time: 90, value: 75 },
      { time: 130, value: 5 },
    ],
  },
  {
    name: "uneven knot spacing",
    points: [
      { time: 0, value: 1 },
      { time: 5, value: 9 },
      { time: 7, value: 2 },
      { time: 200, value: 200 },
    ],
  },
];

const PATH_BATTERY: { name: string; controlPoints: Point2D[] }[] = [
  {
    name: "open S-curve",
    controlPoints: [
      { x: 0, y: 0 },
      { x: 100, y: 200 },
      { x: 300, y: -50 },
      { x: 500, y: 120 },
    ],
  },
  {
    name: "tight zigzag",
    controlPoints: [
      { x: 0, y: 0 },
      { x: 20, y: 200 },
      { x: 40, y: 0 },
      { x: 60, y: 200 },
      { x: 80, y: 0 },
    ],
  },
  {
    name: "near-collinear",
    controlPoints: [
      { x: 0, y: 0 },
      { x: 100, y: 1 },
      { x: 200, y: -1 },
      { x: 300, y: 0 },
    ],
  },
];

// Speed factors are SplineParameters whose VALUE is a unitless multiplier and
// whose TIME axis is in ticks (matching the old speed engine).
const SPEED_BATTERY: { name: string; points: SplinePoint[] }[] = [
  {
    name: "slow-to-fast ramp",
    points: [
      { time: 0, value: 0.5 },
      { time: 2 * TICKS_PER_SECOND, value: 2 },
    ],
  },
  {
    name: "fast-to-slow ramp",
    points: [
      { time: 0, value: 3 },
      { time: 4 * TICKS_PER_SECOND, value: 0.5 },
    ],
  },
  {
    name: "dip then recover",
    points: [
      { time: 0, value: 1 },
      { time: 1.5 * TICKS_PER_SECOND, value: 0.2 },
      { time: 3 * TICKS_PER_SECOND, value: 1.5 },
    ],
  },
];

// --- TESTS -------------------------------------------------------------------

describe("animation refactor parity (new public path vs HEAD references)", () => {
  it("scalar spline resolution is numerically transparent", () => {
    let worst: Divergence = { max: 0, atInput: "none" };
    for (const { name, points } of SCALAR_BATTERY) {
      const param = spline(points);
      const first = points[0].time;
      const last = points[points.length - 1].time;
      // Include before-first and after-last to exercise extrapolation, plus
      // exact knot times.
      const grid = [
        ...linspace(first - 25, last + 25, 200),
        ...points.map((p) => p.time),
      ];
      for (const t of grid) {
        const next = resolveScalar(param, t);
        const reference = oldResolveSpline(points, t);
        worst = trackMax(worst, Math.abs(next - reference), () =>
          `${name} @ t=${t}: new=${next} old=${reference}`,
        );
      }
    }
    expect(worst.max, `worst scalar divergence: ${worst.atInput}`).toBeLessThan(
      EPSILON,
    );
  });

  it("position-path geometry sampling is numerically transparent", () => {
    let worst: Divergence = { max: 0, atInput: "none" };
    for (const { name, controlPoints } of PATH_BATTERY) {
      // timing omitted -> progress == clamped normalized time, so vt drives
      // progress directly and isolates geometry from the timing scalar.
      const param = { controlPoints } as unknown as SpatialPathParameter;
      for (const progress of linspace(0, 1, 250)) {
        const next = samplePositionPath(param, progress, 1);
        const reference = oldSamplePath(controlPoints, progress);
        const diff = Math.max(
          Math.abs(next.x - reference.x),
          Math.abs(next.y - reference.y),
        );
        worst = trackMax(worst, diff, () =>
          `${name} @ p=${progress}: new=(${next.x},${next.y}) old=(${reference.x},${reference.y})`,
        );
      }
    }
    expect(worst.max, `worst path divergence: ${worst.atInput}`).toBeLessThan(
      EPSILON,
    );
  });

  it("speed-ramp time inversion is numerically transparent", () => {
    let worst: Divergence = { max: 0, atInput: "none" };
    for (const extrapolate of [true, false]) {
      for (const { name, points } of SPEED_BATTERY) {
        const factor = spline(points);
        const duration = points[points.length - 1].time;
        const grid = linspace(-0.25 * duration, 1.5 * duration, 200);
        for (const outputTime of grid) {
          const next = getIdempotentTimeMap(factor, outputTime, extrapolate);
          const reference = oldIdempotentTimeMap(points, outputTime, extrapolate);
          worst = trackMax(worst, Math.abs(next - reference), () =>
            `${name} (extrapolate=${extrapolate}) @ t=${outputTime}: new=${next} old=${reference}`,
          );
        }
      }
    }
    expect(worst.max, `worst speed-map divergence: ${worst.atInput}`).toBeLessThan(
      EPSILON,
    );
  });

  it("constant numeric scalar and speed factors are unaffected", () => {
    expect(resolveScalar(0.75, 1234)).toBe(0.75);
    // Numeric speed factor: old and new both return outputTime * factor.
    for (const factor of [0.5, 1, 2.5]) {
      for (const t of [-100, 0, 333.3, 9001]) {
        expect(getIdempotentTimeMap(factor, t, true)).toBeCloseTo(t * factor, 9);
      }
    }
  });
});
