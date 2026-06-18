// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  getMaskLocalTransforms,
  getMaskPositionPath,
  getMaskPositionTransform,
  normalizeSam2Points,
  resolveMaskLayoutTransformIds,
} from "../useMaskInteractionController";
import type {
  ClipMaskPoint,
  ClipTransform,
  MaskTimelineClip,
} from "../../../../../types/TimelineTypes";

function maskClip(transformations: ClipTransform[]): MaskTimelineClip {
  return { transformations } as unknown as MaskTimelineClip;
}

function transform(
  type: string,
  id: string,
  parameters: Record<string, unknown> = {},
): ClipTransform {
  return { type, id, isEnabled: true, parameters } as unknown as ClipTransform;
}

describe("getMaskLocalTransforms", () => {
  it("drops inherited speed transforms but keeps the rest", () => {
    const clip = maskClip([
      transform("speed", "s1"),
      transform("position", "p1"),
      transform("scale", "sc1"),
    ]);
    const local = getMaskLocalTransforms(clip);
    expect(local.map((t) => t.type)).toEqual(["position", "scale"]);
  });

  it("tolerates a clip with no transformations", () => {
    expect(getMaskLocalTransforms(maskClip([]))).toEqual([]);
    expect(getMaskLocalTransforms({} as MaskTimelineClip)).toEqual([]);
  });
});

describe("resolveMaskLayoutTransformIds", () => {
  it("maps the layout transform ids, leaving missing ones null", () => {
    const clip = maskClip([
      transform("position", "pos-1"),
      transform("rotation", "rot-1"),
      transform("speed", "speed-1"),
    ]);
    expect(resolveMaskLayoutTransformIds(clip)).toEqual({
      position: "pos-1",
      scale: null,
      rotation: "rot-1",
    });
  });

  it("returns all-null when there are no layout transforms", () => {
    expect(resolveMaskLayoutTransformIds(maskClip([]))).toEqual({
      position: null,
      scale: null,
      rotation: null,
    });
  });
});

describe("normalizeSam2Points", () => {
  it("returns an empty array for missing or empty input", () => {
    expect(normalizeSam2Points(undefined)).toEqual([]);
    expect(normalizeSam2Points([])).toEqual([]);
  });

  it("clamps coordinates, normalizes labels, and defaults invalid times", () => {
    const input: ClipMaskPoint[] = [
      { x: -0.5, y: 1.4, label: 1, timeTicks: 120 },
      { x: Number.NaN, y: 0.3, label: 0, timeTicks: Number.POSITIVE_INFINITY },
      { x: 0.2, y: 0.8, label: 5 as 0 | 1, timeTicks: Number.NaN },
    ];

    expect(normalizeSam2Points(input)).toEqual([
      { x: 0, y: 1, label: 1, timeTicks: 120 },
      { x: 0.5, y: 0.3, label: 0, timeTicks: 0 },
      { x: 0.2, y: 0.8, label: 1, timeTicks: 0 },
    ]);
  });
});

describe("getMaskPositionTransform / getMaskPositionPath", () => {
  it("finds the position transform and its path parameter", () => {
    const path = { type: "path2d" };
    const clip = maskClip([
      transform("scale", "sc1"),
      transform("position", "p1", { path }),
    ]);
    expect(getMaskPositionTransform(clip)?.id).toBe("p1");
    expect(getMaskPositionPath(clip)).toBe(path);
  });

  it("returns null when there is no position transform", () => {
    const clip = maskClip([transform("scale", "sc1")]);
    expect(getMaskPositionTransform(clip)).toBeNull();
    expect(getMaskPositionPath(clip)).toBeNull();
  });

  it("returns null path when the position transform has no path", () => {
    const clip = maskClip([transform("position", "p1")]);
    expect(getMaskPositionPath(clip)).toBeNull();
  });
});
