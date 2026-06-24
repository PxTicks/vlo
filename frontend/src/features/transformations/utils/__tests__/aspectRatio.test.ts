import { describe, expect, it } from "vitest";
import type { ScalarParameter } from "../../types";
import { calculateLinkedParameter, calculateLinkedValue } from "../aspectRatio";

describe("aspectRatio", () => {
  it("scales and rounds linked numeric values", () => {
    expect(calculateLinkedValue(4, 3, 10)).toBe(7.5);
    expect(calculateLinkedValue(3, 1, 2)).toBe(0.667);
    expect(calculateLinkedValue(0, 10, 2)).toBeNull();
  });

  it("uses scalar and spline representative values", () => {
    const current: ScalarParameter = {
      type: "spline",
      points: [{ time: 0, value: 2 }],
    };
    expect(calculateLinkedParameter(current, 6, 4)).toBe(12);
    expect(
      calculateLinkedParameter(
        current,
        {
          type: "spline",
          points: [{ time: 0, value: 6 }],
        },
        1.1111,
      ),
    ).toBe(3.333);
  });

  it("transfers spline shape while scaling point values", () => {
    const next: ScalarParameter = {
      type: "spline",
      points: [
        { time: 0, value: 1 },
        { time: 10, value: 3 },
      ],
    };
    expect(calculateLinkedParameter(2, 4, next)).toEqual({
      type: "spline",
      points: [
        { time: 0, value: 2 },
        { time: 10, value: 6 },
      ],
    });
  });

  it("returns null for zero or unsupported representative values", () => {
    const emptySpline: ScalarParameter = { type: "spline", points: [] };
    expect(calculateLinkedParameter(0, 10, 5)).toBeNull();
    expect(calculateLinkedParameter(emptySpline, 10, 5)).toBeNull();
    expect(
      calculateLinkedParameter(
        2,
        4,
        null as unknown as ScalarParameter,
      ),
    ).toBeNull();
  });
});
