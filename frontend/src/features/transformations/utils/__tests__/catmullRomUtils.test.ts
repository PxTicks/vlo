import { describe, it, expect } from "vitest";
import {
  distance,
  evaluateCatmullRom,
  evaluateOpenPath,
  generateArcLengthTable,
  samplePathAtProgress,
  insertControlPoint,
  coarseGrainDragSamples,
  simplifyPath,
  processRawDragSamples
} from "../catmullRomUtils";

import type { Point2D, RawDragSample } from "../catmullRomUtils";

describe("catmullRomUtils", () => {
  describe("distance math", () => {
    it("should calculate correct distance", () => {
      const p1 = { x: 0, y: 0 };
      const p2 = { x: 3, y: 4 };
      expect(distance(p1, p2)).toBe(5);
    });
  });

  describe("evaluateCatmullRom", () => {
    it("should interpolate exactly at control points for t=0 and t=1", () => {
      const p0 = { x: 0, y: 0 };
      const p1 = { x: 10, y: 0 };
      const p2 = { x: 20, y: 0 };
      const p3 = { x: 30, y: 0 };

      const at0 = evaluateCatmullRom(p0, p1, p2, p3, 0);
      expect(at0.x).toBeCloseTo(10);
      expect(at0.y).toBeCloseTo(0);

      const at1 = evaluateCatmullRom(p0, p1, p2, p3, 1);
      expect(at1.x).toBeCloseTo(20);
      expect(at1.y).toBeCloseTo(0);
    });

    it("should interpolate middle point correctly for linear collinear points", () => {
      const p0 = { x: 0, y: 0 };
      const p1 = { x: 10, y: 0 };
      const p2 = { x: 20, y: 0 };
      const p3 = { x: 30, y: 0 };

      const mid = evaluateCatmullRom(p0, p1, p2, p3, 0.5);
      expect(mid.x).toBeCloseTo(15);
      expect(mid.y).toBeCloseTo(0);
    });

    it("handles coincident control points without NaN", () => {
      const p0 = { x: 0, y: 0 };
      const p1 = { x: 10, y: 0 };
      
      const res = evaluateCatmullRom(p0, p1, p1, p1, 0.5);
      expect(res.x).toBeTypeOf("number");
      expect(res.y).toBeTypeOf("number");
      expect(Number.isNaN(res.x)).toBe(false);
      expect(Number.isNaN(res.y)).toBe(false);
      expect(res.x).toBeCloseTo(10);
    });
  });

  describe("evaluateOpenPath", () => {
    it("mirrors endpoints correctly for first segment", () => {
      const points: Point2D[] = [
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 30, y: 0 }
      ];
      // Segment 0 is between points[0] and points[1]
      const mid = evaluateOpenPath(points, 0, 0.5);
      expect(mid.x).toBeTypeOf("number");
      expect(Number.isNaN(mid.x)).toBe(false);
      expect(mid.x).toBeCloseTo(15);
    });
  });

  describe("arc length and sampling", () => {
    it("generates correct arc length table and samples from it", () => {
      const points: Point2D[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 }
      ];

      const table = generateArcLengthTable(points, 10);
      expect(table.length).toBeGreaterThan(0);
      
      const totalLength = table[table.length - 1].length;
      expect(totalLength).toBeCloseTo(20);

      // Sample exactly halfway (u=0.5)
      const midPoint = samplePathAtProgress(points, table, 0.5);
      expect(midPoint.x).toBeCloseTo(10);
      expect(midPoint.y).toBeCloseTo(0);

      // Sample at u=0.25
      const quarterPoint = samplePathAtProgress(points, table, 0.25);
      expect(quarterPoint.x).toBeCloseTo(5);
    });

    it("inserts a control point exactly where sampled", () => {
      const points: Point2D[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 }
      ];
      const table = generateArcLengthTable(points, 10);
      
      const newPoints = insertControlPoint(points, table, 0.75);
      expect(newPoints.length).toBe(4);
      
      // The inserted point should be near x=15
      expect(newPoints[2].x).toBeCloseTo(15);
      expect(newPoints[2].y).toBeCloseTo(0);
    });
  });

  describe("coarse graining and simplification", () => {
    it("drops near-duplicate samples", () => {
      const samples: RawDragSample[] = [
        { point: { x: 0, y: 0 }, time: 0 },
        { point: { x: 0.5, y: 0 }, time: 1 }, // dropped if epsilon=2
        { point: { x: 3, y: 0 }, time: 2 },
        { point: { x: 3.5, y: 0 }, time: 3 }, // dropped
        { point: { x: 6, y: 0 }, time: 4 }
      ];
      const coarse = coarseGrainDragSamples(samples, 2.0);
      expect(coarse.length).toBe(3);
      expect(coarse[0].point.x).toBe(0);
      expect(coarse[1].point.x).toBe(3);
      expect(coarse[2].point.x).toBe(6);
    });

    it("simplifies path using Ramer-Douglas-Peucker", () => {
      const samples: RawDragSample[] = [
        { point: { x: 0, y: 0 }, time: 0 },
        { point: { x: 5, y: 0.1 }, time: 1 }, // near collinear, should be dropped
        { point: { x: 10, y: 0 }, time: 2 }
      ];
      const simplified = simplifyPath(samples, 1.0);
      expect(simplified.length).toBe(2);
      expect(simplified[0].point.x).toBe(0);
      expect(simplified[1].point.x).toBe(10);
    });

    it("processes full raw drag pipeline and extracts timing spline", () => {
      const samples: RawDragSample[] = [
        { point: { x: 0, y: 0 }, time: 0 },
        { point: { x: 5, y: 5 }, time: 500 },
        { point: { x: 10, y: 0 }, time: 1000 }
      ];
      const result = processRawDragSamples(samples, 1.0, 0.5);
      
      expect(result.points.length).toBe(3);
      expect(result.timingSplinePoints.length).toBe(3);
      
      // First point
      expect(result.timingSplinePoints[0].time).toBe(0);
      expect(result.timingSplinePoints[0].value).toBe(0);

      // Mid point
      expect(result.timingSplinePoints[1].time).toBeCloseTo(0.5);
      expect(result.timingSplinePoints[1].value).toBeCloseTo(0.5);

      // Last point
      expect(result.timingSplinePoints[2].time).toBe(1);
      expect(result.timingSplinePoints[2].value).toBe(1);
    });
  });
});
