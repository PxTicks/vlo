import { describe, expect, it } from "vitest";
import type { ClipMaskPoint } from "../../../../types/TimelineTypes";
import { hashSam2Points } from "../sam2SourceFrame";

const point = (overrides: Partial<ClipMaskPoint> = {}): ClipMaskPoint => ({
  x: 0.5,
  y: 0.5,
  label: 1,
  timeTicks: 1000,
  ...overrides,
});

describe("hashSam2Points", () => {
  it("is stable for the same point set (the override freshness contract)", () => {
    const points = [point(), point({ x: 0.25, label: 0, timeTicks: 2000 })];
    expect(hashSam2Points(points)).toBe(hashSam2Points([...points]));
  });

  it("changes when any point field changes so edits invalidate the preview", () => {
    const base = [point()];
    const baseHash = hashSam2Points(base);
    expect(hashSam2Points([point({ x: 0.6 })])).not.toBe(baseHash);
    expect(hashSam2Points([point({ label: 0 })])).not.toBe(baseHash);
    expect(hashSam2Points([point({ timeTicks: 1001 })])).not.toBe(baseHash);
    expect(hashSam2Points([point(), point({ x: 0.1 })])).not.toBe(baseHash);
  });

  it("treats an empty set distinctly and deterministically", () => {
    expect(hashSam2Points([])).toBe(hashSam2Points([]));
    expect(hashSam2Points([])).not.toBe(hashSam2Points([point()]));
  });
});
