import { describe, expect, it } from "vitest";
import { clipLocalPointToBrushCanvasPoint } from "../brushCoordinates";

describe("clipLocalPointToBrushCanvasPoint", () => {
  it("maps clip-local points into the full brush canvas", () => {
    expect(
      clipLocalPointToBrushCanvasPoint(
        { x: 20, y: -10 },
        { width: 120, height: 80 },
        { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      ),
    ).toEqual({ x: 80, y: 30 });
  });

  it("inverts brush layout scale and position", () => {
    expect(
      clipLocalPointToBrushCanvasPoint(
        { x: 40, y: 30 },
        { width: 120, height: 120 },
        { x: 20, y: 10, scaleX: 2, scaleY: 4, rotation: 0 },
      ),
    ).toEqual({ x: 70, y: 65 });
  });

  it("inverts brush layout rotation", () => {
    const point = clipLocalPointToBrushCanvasPoint(
      { x: 0, y: 10 },
      { width: 100, height: 100 },
      { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: Math.PI / 2 },
    );

    expect(point.x).toBeCloseTo(60);
    expect(point.y).toBeCloseTo(50);
  });
});
