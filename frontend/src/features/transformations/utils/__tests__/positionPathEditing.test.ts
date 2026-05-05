import { describe, expect, it } from "vitest";
import {
  findControlPointIndexNearProgress,
  findNearestControlPointIndexByProgress,
  upsertPathControlPointAtProgress,
} from "../positionPathEditing";

describe("positionPathEditing", () => {
  it("chooses the nearest matching control point by progress", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 49, y: 0 },
      { x: 51, y: 0 },
      { x: 100, y: 0 },
    ];

    expect(findControlPointIndexNearProgress(points, 0.52, 0.05)).toBe(2);
    const nearest = findNearestControlPointIndexByProgress(points, 0.48);
    expect(nearest.index).toBe(1);
    expect(nearest.distance).toBeGreaterThanOrEqual(0);
  });

  it("returns the inserted control point index so edits stay bound to one slot", () => {
    const path = {
      type: "path2d" as const,
      curve: "centripetal_catmull_rom" as const,
      controlPoints: [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 60, y: 0 },
        { x: 100, y: 0 },
      ],
      timing: {
        type: "spline" as const,
        points: [
          { time: 0, value: 0 },
          { time: 1, value: 1 },
        ],
      },
    };

    const result = upsertPathControlPointAtProgress(
      path,
      0.5,
      { x: 50, y: 20 },
      0.01,
    );

    expect(result.inserted).toBe(true);
    expect(result.points[result.index]).toEqual({ x: 50, y: 20 });
    expect(result.points).toHaveLength(path.controlPoints.length + 1);
  });
});
