import { describe, expect, it } from "vitest";
import {
  reflectKeyframeTimes,
  reflectScalarParameterTime,
  reflectSplinePointsBoth,
  reflectSplinePointsTime,
  reverseNormalizedTimingSpline,
  reversePositionPath,
} from "../reverseSpline";
import type {
  PositionPathParameter,
  SplineParameter,
} from "../../types";

describe("reflectSplinePointsTime", () => {
  it("mirrors only the time axis", () => {
    const result = reflectSplinePointsTime(
      [
        { time: 100, value: 0.2 },
        { time: 400, value: 0.8 },
      ],
      500,
    );
    expect(result).toEqual([
      { time: 600, value: 0.8 },
      { time: 900, value: 0.2 },
    ]);
  });

  it("sorts results ascending by time after reflection", () => {
    const result = reflectSplinePointsTime(
      [
        { time: 0, value: 1 },
        { time: 200, value: 2 },
        { time: 1000, value: 3 },
      ],
      500,
    );
    expect(result.map((p) => p.time)).toEqual([0, 800, 1000]);
  });

  it("is involutive at the same mirror point", () => {
    const original = [
      { time: 10, value: 1 },
      { time: 70, value: 2 },
      { time: 100, value: 3 },
    ];
    const once = reflectSplinePointsTime(original, 55);
    const twice = reflectSplinePointsTime(once, 55);
    expect(twice).toEqual(
      [...original].sort((a, b) => a.time - b.time),
    );
  });
});

describe("reflectSplinePointsBoth", () => {
  it("mirrors both axes around the supplied center", () => {
    const result = reflectSplinePointsBoth(
      [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
      ],
      0.5,
      0.5,
    );
    expect(result).toEqual([
      { time: 0, value: 0 },
      { time: 1, value: 1 },
    ]);
  });

  it("flips a non-symmetric S-curve to preserve monotonicity 0->1", () => {
    const result = reflectSplinePointsBoth(
      [
        { time: 0, value: 0 },
        { time: 0.3, value: 0.7 },
        { time: 1, value: 1 },
      ],
      0.5,
      0.5,
    );
    expect(result).toHaveLength(3);
    expect(result[0].time).toBeCloseTo(0);
    expect(result[0].value).toBeCloseTo(0);
    expect(result[1].time).toBeCloseTo(0.7);
    expect(result[1].value).toBeCloseTo(0.3);
    expect(result[2].time).toBeCloseTo(1);
    expect(result[2].value).toBeCloseTo(1);
  });
});

describe("reflectScalarParameterTime", () => {
  it("passes through plain numbers untouched", () => {
    expect(reflectScalarParameterTime(42, 100)).toBe(42);
    expect(reflectScalarParameterTime(undefined, 100)).toBeUndefined();
  });

  it("mirrors spline-parameter points around the mirror time", () => {
    const param: SplineParameter = {
      type: "spline",
      points: [
        { time: 0, value: 0 },
        { time: 96000, value: 100 },
      ],
    };
    const reflected = reflectScalarParameterTime(param, 48000);
    expect(reflected).toMatchObject({
      type: "spline",
      points: [
        { time: 0, value: 100 },
        { time: 96000, value: 0 },
      ],
    });
  });
});

describe("reverseNormalizedTimingSpline", () => {
  it("preserves the endpoints of the standard 0->1 ramp", () => {
    const reversed = reverseNormalizedTimingSpline({
      type: "spline",
      points: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
      ],
    });
    expect(reversed.points).toEqual([
      { time: 0, value: 0 },
      { time: 1, value: 1 },
    ]);
  });

  it("flips an ease-in curve into an ease-out one", () => {
    const reversed = reverseNormalizedTimingSpline({
      type: "spline",
      points: [
        { time: 0, value: 0 },
        { time: 0.25, value: 0.05 },
        { time: 1, value: 1 },
      ],
    });
    expect(reversed.points).toEqual([
      { time: 0, value: 0 },
      { time: 0.75, value: 0.95 },
      { time: 1, value: 1 },
    ]);
  });
});

describe("reflectKeyframeTimes", () => {
  it("mirrors and re-sorts", () => {
    expect(reflectKeyframeTimes([100, 500, 200], 300)).toEqual([100, 400, 500]);
  });

  it("leaves undefined alone", () => {
    expect(reflectKeyframeTimes(undefined, 100)).toBeUndefined();
  });
});

describe("reversePositionPath", () => {
  const ORIGINAL_POINTS = [
    { x: 0, y: 0 },
    { x: 100, y: 50 },
    { x: 200, y: 0 },
  ];

  it("reverses controlPoints AND mirrors the timing spline", () => {
    const path: PositionPathParameter = {
      type: "path2d",
      curve: "centripetal_catmull_rom",
      controlPoints: ORIGINAL_POINTS,
      timing: {
        type: "spline",
        points: [
          { time: 0, value: 0 },
          { time: 0.4, value: 0.9 },
          { time: 1, value: 1 },
        ],
      },
    };

    const reversed = reversePositionPath(path);

    // controlPoints reversed and deep-copied
    expect(reversed.controlPoints).toEqual(
      [...ORIGINAL_POINTS].reverse(),
    );
    expect(reversed.controlPoints).not.toBe(path.controlPoints);
    expect(reversed.controlPoints[0]).not.toBe(path.controlPoints[2]);

    // Timing reflected about (0.5, 0.5), sorted, endpoints preserved
    expect(reversed.timing.points).toHaveLength(3);
    expect(reversed.timing.points[0].time).toBeCloseTo(0);
    expect(reversed.timing.points[0].value).toBeCloseTo(0);
    expect(reversed.timing.points[1].time).toBeCloseTo(0.6);
    expect(reversed.timing.points[1].value).toBeCloseTo(0.1);
    expect(reversed.timing.points[2].time).toBeCloseTo(1);
    expect(reversed.timing.points[2].value).toBeCloseTo(1);
  });

  it("is involutive: reversing twice returns the original path", () => {
    const path: PositionPathParameter = {
      type: "path2d",
      curve: "centripetal_catmull_rom",
      controlPoints: ORIGINAL_POINTS,
      timing: {
        type: "spline",
        points: [
          { time: 0, value: 0 },
          { time: 0.25, value: 0.1 },
          { time: 1, value: 1 },
        ],
      },
    };

    const twice = reversePositionPath(reversePositionPath(path));

    expect(twice.controlPoints).toEqual(ORIGINAL_POINTS);
    expect(twice.timing.points).toHaveLength(3);
    expect(twice.timing.points[0].time).toBeCloseTo(0);
    expect(twice.timing.points[0].value).toBeCloseTo(0);
    expect(twice.timing.points[1].time).toBeCloseTo(0.25);
    expect(twice.timing.points[1].value).toBeCloseTo(0.1);
    expect(twice.timing.points[2].time).toBeCloseTo(1);
    expect(twice.timing.points[2].value).toBeCloseTo(1);
  });
});
