import { describe, expect, it } from "vitest";
import { createCentroidStabilizedPath } from "../centroidPath";

describe("createCentroidStabilizedPath", () => {
  it("builds a counter-motion path that keeps the first centroid anchored", () => {
    const path = createCentroidStabilizedPath([
      {
        time: 0,
        position: { x: 0, y: 0 },
        centroid: { x: 10, y: 20 },
      },
      {
        time: 50,
        position: { x: 0, y: 0 },
        centroid: { x: 40, y: 5 },
      },
      {
        time: 100,
        position: { x: 0, y: 0 },
        centroid: { x: 60, y: 25 },
      },
    ]);

    expect(path?.controlPoints[0]).toEqual({ x: 0, y: 0 });
    expect(path?.controlPoints.at(-1)).toEqual({ x: -50, y: -5 });
    expect(path?.timing.points[0]).toEqual({ time: 0, value: 0 });
    expect(path?.timing.points.at(-1)).toEqual({ time: 1, value: 1 });
  });

  it("returns null when centroid movement does not change the target position", () => {
    const path = createCentroidStabilizedPath([
      {
        time: 0,
        position: { x: 5, y: 5 },
        centroid: { x: 10, y: 10 },
      },
      {
        time: 100,
        position: { x: 5, y: 5 },
        centroid: { x: 10.1, y: 10.1 },
      },
    ]);

    expect(path).toBeNull();
  });
});
