import { describe, expect, it } from "vitest";
import { MonotoneCubicSpline } from "../MonotoneCubicSpline";

describe("MonotoneCubicSpline behavior", () => {
  it("handles empty and single-point splines", () => {
    const empty = new MonotoneCubicSpline([]);
    expect(empty.at(10)).toBe(0);
    expect(empty.integrate(10)).toBe(0);
    expect(empty.solveX(10)).toBe(0);
    expect(empty.getSVGPath()).toBe("");

    const single = new MonotoneCubicSpline([{ time: 4, value: 3 }]);
    expect(single.at(-100)).toBe(3);
    expect(single.solveX(100)).toBe(4);
    expect(single.integrate(2)).toBe(-6);
    expect(single.integrate(6)).toBe(6);
    expect(single.getSVGPath()).toBe("M 4 3");
  });

  it("sorts points and removes effectively duplicate times", () => {
    const spline = new MonotoneCubicSpline([
      { time: 2, value: 20 },
      { time: 0, value: 0 },
      { time: 0.0000001, value: 99 },
      { time: 1, value: 10 },
    ]);
    expect(spline.at(0)).toBe(0);
    expect(spline.at(1)).toBeCloseTo(10);
    expect(spline.at(2)).toBe(20);
  });

  it("clamps values at boundaries unless extrapolation is requested", () => {
    const spline = new MonotoneCubicSpline([
      { time: 1, value: 2 },
      { time: 3, value: 6 },
    ]);
    expect(spline.at(0)).toBe(2);
    expect(spline.at(0, true)).toBe(0);
    expect(spline.at(4)).toBe(6);
    expect(spline.at(4, true)).toBe(8);
  });

  it("integrates before, within, across, and after spline segments", () => {
    const spline = new MonotoneCubicSpline([
      { time: 0, value: 1 },
      { time: 1, value: 2 },
      { time: 2, value: 4 },
      { time: 3, value: 4 },
    ]);
    expect(spline.integrate(-2)).toBe(-2);
    expect(spline.integrate(0.5)).toBeGreaterThan(0.5);
    expect(spline.integrate(1.5)).toBeGreaterThan(spline.integrate(1));
    expect(spline.integrate(5)).toBeCloseTo(spline.integrate(3) + 8);
  });

  it("builds cubic SVG segments for every interval", () => {
    const spline = new MonotoneCubicSpline([
      { time: 0, value: 0 },
      { time: 2, value: 1 },
      { time: 4, value: 3 },
    ]);
    const path = spline.getSVGPath();
    expect(path).toMatch(/^M 0 0 C /);
    expect(path.match(/ C /g)).toHaveLength(2);
    expect(path).toContain(", 4 3");
  });

  it("handles flat endpoint inversion and searches later segments", () => {
    const flatStart = new MonotoneCubicSpline([
      { time: 0, value: 2 },
      { time: 1, value: 2 },
      { time: 2, value: 5 },
    ]);
    expect(flatStart.solveX(1)).toBe(0);

    const flatEnd = new MonotoneCubicSpline([
      { time: 0, value: 0 },
      { time: 1, value: 3 },
      { time: 2, value: 3 },
    ]);
    expect(flatEnd.solveX(4)).toBe(2);

    const multi = new MonotoneCubicSpline([
      { time: 0, value: 0 },
      { time: 1, value: 1 },
      { time: 2, value: 4 },
      { time: 3, value: 9 },
    ]);
    const target = multi.at(2.5);
    expect(multi.solveX(target)).toBeCloseTo(2.5, 4);
  });

  it("preserves decreasing and sharply changing data without overshoot", () => {
    const spline = new MonotoneCubicSpline([
      { time: 0, value: 10 },
      { time: 1, value: 5 },
      { time: 2, value: 5 },
      { time: 3, value: 0 },
    ]);
    for (const time of [0.25, 0.75, 1.25, 1.75, 2.5]) {
      expect(spline.at(time)).toBeGreaterThanOrEqual(0);
      expect(spline.at(time)).toBeLessThanOrEqual(10);
    }
  });
});
