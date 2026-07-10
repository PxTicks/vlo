import { describe, expect, it } from "vitest";
import {
  adjustmentToWheelPoint,
  wheelPointToAdjustment,
} from "../wheelMath";

describe("color wheel math", () => {
  it("keeps the wheel center neutral", () => {
    expect(wheelPointToAdjustment(0, 0, 40, 0.3)).toEqual({
      r: 0,
      g: 0,
      b: 0,
    });
  });

  it("produces a zero-sum chroma adjustment", () => {
    const value = wheelPointToAdjustment(40, 0, 40, 0.3);
    expect(value.r + value.g + value.b).toBeCloseTo(0, 12);
    expect(value.r).toBeGreaterThan(value.g);
  });

  it("scales fine drags and maps adjustments back to a marker", () => {
    const normal = wheelPointToAdjustment(20, 10, 40, 0.5);
    const fine = wheelPointToAdjustment(20, 10, 40, 0.5, true);
    expect(fine.r).toBeCloseTo(normal.r * 0.2, 12);
    const marker = adjustmentToWheelPoint(normal, 40, 0.5);
    expect(Math.hypot(marker.x, marker.y)).toBeGreaterThan(0);
  });

  it("round-trips wheel radius at non-primary hues", () => {
    const angle = Math.PI / 6;
    const x = Math.cos(angle) * 32;
    const y = Math.sin(angle) * 32;
    const adjustment = wheelPointToAdjustment(x, y, 40, 0.5);
    const marker = adjustmentToWheelPoint(adjustment, 40, 0.5);
    expect(marker.x).toBeCloseTo(x, 10);
    expect(marker.y).toBeCloseTo(y, 10);
  });
});
