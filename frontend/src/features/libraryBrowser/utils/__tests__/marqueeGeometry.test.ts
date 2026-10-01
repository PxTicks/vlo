import { describe, expect, it } from "vitest";
import {
  getItemIndicesInRect,
  rectFromPoints,
  type GridGeometry,
} from "../marqueeGeometry";

// Two 176px columns at x 16-192 and 208-384; rows at y 16-166 and 182-332.
const GEOMETRY: GridGeometry = {
  columnCount: 2,
  contentWidth: 400,
  gapPx: 16,
  paddingXPx: 16,
  rows: [
    { start: 16, size: 150 },
    { start: 182, size: 150 },
  ],
};

describe("rectFromPoints", () => {
  it("normalizes a drag in any direction", () => {
    expect(rectFromPoints({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({
      left: 10,
      top: 20,
      right: 50,
      bottom: 80,
    });
  });
});

describe("getItemIndicesInRect", () => {
  it("selects every cell the rect intersects", () => {
    const rect = rectFromPoints({ x: 100, y: 100 }, { x: 300, y: 200 });
    expect(getItemIndicesInRect(rect, GEOMETRY, 4)).toEqual([0, 1, 2, 3]);
  });

  it("selects nothing when the rect sits entirely in gaps", () => {
    const columnGap = rectFromPoints({ x: 194, y: 0 }, { x: 206, y: 400 });
    const rowGap = rectFromPoints({ x: 0, y: 168 }, { x: 400, y: 180 });
    expect(getItemIndicesInRect(columnGap, GEOMETRY, 4)).toEqual([]);
    expect(getItemIndicesInRect(rowGap, GEOMETRY, 4)).toEqual([]);
  });

  it("restricts the hit to the columns the rect spans", () => {
    const rect = rectFromPoints({ x: 0, y: 0 }, { x: 100, y: 400 });
    expect(getItemIndicesInRect(rect, GEOMETRY, 4)).toEqual([0, 2]);
  });

  it("skips filler slots past the last item", () => {
    const rect = rectFromPoints({ x: 0, y: 0 }, { x: 400, y: 400 });
    expect(getItemIndicesInRect(rect, GEOMETRY, 3)).toEqual([0, 1, 2]);
  });
});
