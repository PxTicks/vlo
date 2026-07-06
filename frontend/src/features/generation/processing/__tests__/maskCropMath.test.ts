/**
 * Behavioural port of `backend/tests/test_mask_crop.py` — exact numeric
 * parity is covered separately by `parity.fixtures.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  computeCropRegion,
  computeMaskCrop,
  forceAspectRatio,
  getMaskBoundsFromChannel,
  getMaskBoundsFromRgba,
  unionBounds,
} from "../maskCropMath";

function makeChannel(
  width: number,
  height: number,
  fill: (x: number, y: number) => number,
): Uint8Array {
  const channel = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      channel[y * width + x] = fill(x, y);
    }
  }
  return channel;
}

describe("getMaskBoundsFromChannel", () => {
  it("returns null for an empty frame", () => {
    expect(
      getMaskBoundsFromChannel(new Uint8Array(200 * 100), 200, 100, 13),
    ).toBeNull();
  });

  it("finds a single pixel", () => {
    const channel = makeChannel(200, 100, (x, y) =>
      x === 80 && y === 50 ? 255 : 0,
    );
    expect(getMaskBoundsFromChannel(channel, 200, 100, 13)).toEqual([
      80, 50, 81, 51,
    ]);
  });

  it("finds a rectangular region", () => {
    const channel = makeChannel(200, 100, (x, y) =>
      x >= 40 && x < 90 && y >= 10 && y < 30 ? 255 : 0,
    );
    expect(getMaskBoundsFromChannel(channel, 200, 100, 13)).toEqual([
      40, 10, 90, 30,
    ]);
  });

  it("excludes pixels at or below the threshold", () => {
    const channel = makeChannel(200, 100, (x, y) => {
      if (x === 10 && y === 10) return 13;
      if (x === 80 && y === 50) return 20;
      return 0;
    });
    expect(getMaskBoundsFromChannel(channel, 200, 100, 13)).toEqual([
      80, 50, 81, 51,
    ]);
  });

  it("spans scattered pixels", () => {
    const channel = makeChannel(200, 100, (x, y) => {
      if (x === 10 && y === 5) return 255;
      if (x === 180 && y === 90) return 255;
      return 0;
    });
    expect(getMaskBoundsFromChannel(channel, 200, 100, 13)).toEqual([
      10, 5, 181, 91,
    ]);
  });
});

describe("getMaskBoundsFromRgba", () => {
  it("reads the red channel of RGBA data", () => {
    const width = 8;
    const height = 8;
    const rgba = new Uint8ClampedArray(width * height * 4);
    // Red pixel at (3, 4); a bright *blue-only* pixel elsewhere must not count.
    rgba[(4 * width + 3) * 4] = 255;
    rgba[(1 * width + 6) * 4 + 2] = 255;
    expect(getMaskBoundsFromRgba(rgba, width, height)).toEqual([3, 4, 4, 5]);
  });

  it("returns null when only sub-threshold red is present", () => {
    const width = 4;
    const height = 4;
    const rgba = new Uint8ClampedArray(width * height * 4);
    rgba[0] = 32; // exactly at threshold — excluded (strictly greater)
    expect(getMaskBoundsFromRgba(rgba, width, height)).toBeNull();
  });
});

describe("unionBounds", () => {
  it("handles null combinations", () => {
    expect(unionBounds(null, null)).toBeNull();
    expect(unionBounds(null, [10, 20, 30, 40])).toEqual([10, 20, 30, 40]);
    expect(unionBounds([10, 20, 30, 40], null)).toEqual([10, 20, 30, 40]);
  });

  it("unions overlapping boxes", () => {
    expect(unionBounds([10, 20, 30, 40], [5, 25, 35, 50])).toEqual([
      5, 20, 35, 50,
    ]);
  });
});

describe("forceAspectRatio", () => {
  it("keeps a matching box's ratio", () => {
    const [x1, y1, x2, y2] = forceAspectRatio([0, 0, 160, 90], 16 / 9);
    expect((x2 - x1) / (y2 - y1)).toBeCloseTo(16 / 9, 5);
  });

  it("grows height for too-wide boxes", () => {
    const [x1, y1, x2, y2] = forceAspectRatio([0, 0, 200, 50], 1);
    expect(x2 - x1).toBeCloseTo(200, 5);
    expect(y2 - y1).toBeCloseTo(200, 5);
  });

  it("grows width for too-tall boxes", () => {
    const [x1, y1, x2, y2] = forceAspectRatio([0, 0, 50, 200], 1);
    expect(x2 - x1).toBeCloseTo(200, 5);
    expect(y2 - y1).toBeCloseTo(200, 5);
  });

  it("preserves the centre", () => {
    const [x1, y1, x2, y2] = forceAspectRatio([100, 100, 200, 150], 16 / 9);
    expect((x1 + x2) / 2).toBeCloseTo(150, 5);
    expect((y1 + y2) / 2).toBeCloseTo(125, 5);
  });

  it("returns degenerate boxes unchanged", () => {
    expect(forceAspectRatio([100, 100, 100, 150], 16 / 9)).toEqual([
      100, 100, 100, 150,
    ]);
  });
});

describe("computeCropRegion", () => {
  it("produces even in-container dimensions", () => {
    const [x1, y1, x2, y2] = computeCropRegion(
      [100, 100, 300, 212.5],
      0,
      1920,
      1080,
      16 / 9,
    );
    expect((x2 - x1) % 2).toBe(0);
    expect((y2 - y1) % 2).toBe(0);
    expect(x1).toBeGreaterThanOrEqual(0);
    expect(y1).toBeGreaterThanOrEqual(0);
    expect(x2).toBeLessThanOrEqual(1920);
    expect(y2).toBeLessThanOrEqual(1080);
  });

  it("dilation increases the crop size", () => {
    const plain = computeCropRegion([100, 100, 300, 212.5], 0, 1920, 1080, 16 / 9);
    const dilated = computeCropRegion(
      [100, 100, 300, 212.5],
      0.2,
      1920,
      1080,
      16 / 9,
    );
    expect(dilated[2] - dilated[0]).toBeGreaterThan(plain[2] - plain[0]);
  });

  it("caps at the container", () => {
    const [x1, y1, x2, y2] = computeCropRegion(
      [0, 0, 1900, 1068.75],
      0.5,
      1920,
      1080,
      16 / 9,
    );
    expect(x2 - x1).toBeLessThanOrEqual(1920);
    expect(y2 - y1).toBeLessThanOrEqual(1080);
  });

  it("shifts boxes back inside the container", () => {
    expect(
      computeCropRegion([0, 100, 100, 156.25], 0.1, 1920, 1080, 16 / 9)[0],
    ).toBeGreaterThanOrEqual(0);
    expect(
      computeCropRegion([100, 1000, 300, 1080], 0.1, 1920, 1080, 16 / 9)[3],
    ).toBeLessThanOrEqual(1080);
  });
});

describe("computeMaskCrop", () => {
  it("returns null for empty bounds", () => {
    expect(computeMaskCrop(null, 1920, 1080, 16 / 9)).toBeNull();
  });

  it("returns null when the crop covers the whole container", () => {
    expect(computeMaskCrop([0, 0, 1920, 1080], 1920, 1080, 16 / 9, 0)).toBeNull();
  });

  it("crops small regions and contains the original bounds", () => {
    const result = computeMaskCrop([400, 300, 600, 500], 1920, 1080, 16 / 9, 0.1);
    expect(result).not.toBeNull();
    const [x1, y1, x2, y2] = result ?? [0, 0, 0, 0];
    expect(x1).toBeLessThanOrEqual(400);
    expect(y1).toBeLessThanOrEqual(300);
    expect(x2).toBeGreaterThanOrEqual(600);
    expect(y2).toBeGreaterThanOrEqual(500);
    expect((x2 - x1) % 2).toBe(0);
    expect((y2 - y1) % 2).toBe(0);
  });

  it("handles portrait containers", () => {
    const result = computeMaskCrop([100, 200, 200, 400], 608, 1080, 9 / 16, 0.1);
    expect(result).not.toBeNull();
    const [, , x2, y2] = result ?? [0, 0, 0, 0];
    expect(x2).toBeLessThanOrEqual(608);
    expect(y2).toBeLessThanOrEqual(1080);
  });
});
