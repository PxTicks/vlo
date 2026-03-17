import {
  diffSplinePointTimes,
  hasExplicitSplinePointAtTime,
} from "../splineKeyframeUtils";

describe("splineKeyframeUtils", () => {
  it("detects explicit point additions", () => {
    const previous = [
      { time: 100, value: 1 },
      { time: 200, value: 2 },
    ];
    const next = [
      { time: 100, value: 1 },
      { time: 150, value: 3 },
      { time: 200, value: 2 },
    ];

    const diff = diffSplinePointTimes(previous, next, 1);

    expect(diff.addedTimes).toEqual([150]);
    expect(diff.removedTimes).toEqual([]);
  });

  it("detects explicit point removals", () => {
    const previous = [
      { time: 100, value: 1 },
      { time: 200, value: 2 },
      { time: 300, value: 3 },
    ];
    const next = [
      { time: 100, value: 1 },
      { time: 300, value: 3 },
    ];

    const diff = diffSplinePointTimes(previous, next, 1);

    expect(diff.addedTimes).toEqual([]);
    expect(diff.removedTimes).toEqual([200]);
  });

  it("treats small time movement inside epsilon as unchanged", () => {
    const previous = [{ time: 100, value: 1 }];
    const next = [{ time: 100.5, value: 2 }];

    const diff = diffSplinePointTimes(previous, next, 1);

    expect(diff.addedTimes).toEqual([]);
    expect(diff.removedTimes).toEqual([]);
  });

  it("treats movement beyond epsilon as remove + add", () => {
    const previous = [{ time: 100, value: 1 }];
    const next = [{ time: 104, value: 2 }];

    const diff = diffSplinePointTimes(previous, next, 1);

    expect(diff.addedTimes).toEqual([104]);
    expect(diff.removedTimes).toEqual([100]);
  });

  it("checks explicit points on spline params only", () => {
    const spline = {
      type: "spline" as const,
      points: [
        { time: 100, value: 1 },
        { time: 250, value: 2 },
      ],
    };

    expect(hasExplicitSplinePointAtTime(spline, 100, 1)).toBe(true);
    expect(hasExplicitSplinePointAtTime(spline, 251, 1)).toBe(true);
    expect(hasExplicitSplinePointAtTime(spline, 253, 1)).toBe(false);
    expect(hasExplicitSplinePointAtTime(3, 100, 1)).toBe(false);
  });
});
