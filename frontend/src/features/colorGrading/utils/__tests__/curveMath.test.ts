import { describe, expect, it } from "vitest";
import { curvePointFromClient, sampleCurve } from "../curveMath";

describe("value curve math", () => {
  it("maps client coordinates into curve coordinates", () => {
    expect(
      curvePointFromClient(
        60,
        45,
        { left: 10, top: 20, width: 100, height: 100 },
        -0.5,
        0.5,
      ),
    ).toEqual({ x: 0.5, y: 0.25 });
  });

  it("samples identity and periodic curves", () => {
    expect(sampleCurve([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.35, false)).toBeCloseTo(0.35);
    const periodic = [
      { x: 0.1, y: 0.2 },
      { x: 0.5, y: -0.1 },
      { x: 0.9, y: 0.2 },
    ];
    expect(sampleCurve(periodic, -0.01, true)).toBeCloseTo(
      sampleCurve(periodic, 0.99, true),
      12,
    );
  });
});
