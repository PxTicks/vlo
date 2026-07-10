import { describe, expect, it } from "vitest";
import { PeriodicCubicSpline } from "../PeriodicCubicSpline";

describe("PeriodicCubicSpline", () => {
  it("wraps evaluation outside the unit domain", () => {
    const spline = new PeriodicCubicSpline([
      { time: 0.1, value: 0.2 },
      { time: 0.5, value: -0.1 },
      { time: 0.9, value: 0.2 },
    ]);
    expect(spline.at(-0.02)).toBeCloseTo(spline.at(0.98), 12);
    expect(spline.at(1.02)).toBeCloseTo(spline.at(0.02), 12);
  });

  it("is continuous across the hue seam", () => {
    const spline = new PeriodicCubicSpline([
      { time: 0.15, value: 0.25 },
      { time: 0.5, value: -0.2 },
      { time: 0.85, value: 0.2 },
    ]);
    expect(Math.abs(spline.at(1 - 1e-5) - spline.at(1e-5))).toBeLessThan(
      0.0001,
    );
  });

  it("handles empty and single-point curves", () => {
    expect(new PeriodicCubicSpline([]).at(0.4)).toBe(0);
    expect(
      new PeriodicCubicSpline([{ time: 0.3, value: 0.7 }]).at(0.9),
    ).toBe(0.7);
  });
});
