import { describe, expect, it } from "vitest";
import {
  getCachedArcLengthTable,
  resolvePositionPathProgress,
  samplePositionPath,
} from "../positionPath";

describe("positionPath", () => {
  const path = {
    type: "path2d" as const,
    curve: "centripetal_catmull_rom" as const,
    controlPoints: [
      { x: 0, y: 0 },
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

  it("caches the derived arc-length table by persisted path object identity", () => {
    const first = getCachedArcLengthTable(path);
    const second = getCachedArcLengthTable(path);
    const cloned = getCachedArcLengthTable({
      ...path,
      controlPoints: [...path.controlPoints],
      timing: {
        ...path.timing,
        points: [...path.timing.points],
      },
    });

    expect(second).toBe(first);
    expect(cloned).not.toBe(first);
  });

  it("resolves normalized progress and samples by visual clip time", () => {
    expect(resolvePositionPathProgress(path, 50, 100)).toBeCloseTo(0.5, 3);

    const sampled = samplePositionPath(path, 50, 100);
    expect(sampled.x).toBeCloseTo(50, 1);
    expect(sampled.y).toBeCloseTo(0, 1);
  });
});
