import { describe, expect, it } from "vitest";
import { calculateBrushPaintedBoundsFromImageData } from "../brushBufferRegistry";

function createPixels(
  width: number,
  height: number,
  painted: Array<{ x: number; y: number; red?: number }> = [],
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  painted.forEach(({ x, y, red = 255 }) => {
    const offset = (y * width + x) * 4;
    pixels[offset] = red;
    pixels[offset + 3] = 255;
  });
  return pixels;
}

describe("calculateBrushPaintedBoundsFromImageData", () => {
  it("returns null when no painted pixels are present", () => {
    const pixels = createPixels(4, 3);

    expect(calculateBrushPaintedBoundsFromImageData(pixels, 4, 3)).toBeNull();
  });

  it("returns tight bounds around painted pixels", () => {
    const pixels = createPixels(8, 6, [
      { x: 2, y: 1 },
      { x: 5, y: 4 },
      { x: 4, y: 2 },
    ]);

    expect(calculateBrushPaintedBoundsFromImageData(pixels, 8, 6)).toEqual({
      x: 2,
      y: 1,
      width: 4,
      height: 4,
    });
  });

  it("counts faint anti-aliased red edge pixels as painted coverage", () => {
    const pixels = createPixels(5, 5, [{ x: 1, y: 3, red: 1 }]);

    expect(calculateBrushPaintedBoundsFromImageData(pixels, 5, 5)).toEqual({
      x: 1,
      y: 3,
      width: 1,
      height: 1,
    });
  });
});
