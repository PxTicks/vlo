import { describe, expect, it } from "vitest";
import {
  createAspectRatioFixedBoundingBox,
  createBoundingBoxFromMaskPixels,
  createBoundingBoxFromPoints,
  getBoundingBoxCentroid,
  transformBoundingBox,
} from "../bounds";

describe("tracking bounds utilities", () => {
  it("creates a bounding box and centroid from finite points", () => {
    const box = createBoundingBoxFromPoints([
      { x: 10, y: 20 },
      { x: -5, y: 30 },
      { x: 15, y: -10 },
    ]);

    expect(box).toEqual({ x: -5, y: -10, width: 20, height: 40 });
    expect(box ? getBoundingBoxCentroid(box) : null).toEqual({ x: 5, y: 10 });
  });

  it("scans red-channel mask pixels", () => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    const setRed = (x: number, y: number) => {
      pixels[(y * 4 + x) * 4] = 255;
    };
    setRed(1, 1);
    setRed(2, 3);

    expect(createBoundingBoxFromMaskPixels(pixels, 4, 4)).toEqual({
      x: 1,
      y: 1,
      width: 2,
      height: 3,
    });
  });

  it("expands boxes to a fixed aspect ratio around the same centroid", () => {
    const box = createAspectRatioFixedBoundingBox(
      { x: 10, y: 20, width: 20, height: 20 },
      16 / 9,
    );

    expect(getBoundingBoxCentroid(box)).toEqual({ x: 20, y: 30 });
    expect(box.width / box.height).toBeCloseTo(16 / 9);
    expect(box.width).toBeGreaterThan(20);
  });

  it("transforms bounding box corners before rebuilding the box", () => {
    const box = transformBoundingBox(
      { x: -10, y: -5, width: 20, height: 10 },
      { x: 100, y: 50, scaleX: 2, scaleY: 1, rotation: 0 },
    );

    expect(box).toEqual({ x: 80, y: 45, width: 40, height: 10 });
  });
});
