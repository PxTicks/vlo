import { describe, expect, it } from "vitest";
import {
  computeFixedHandleOffset,
  lockCornerScaleAspectRatio,
} from "../layoutInteractionMath";

describe("lockCornerScaleAspectRatio", () => {
  it("preserves independent axis signs when a corner crosses one axis", () => {
    expect(
      lockCornerScaleAspectRatio(
        "se",
        { x: 1, y: 1 },
        { x: -2, y: 0.5 },
      ),
    ).toEqual({ x: -2, y: 2 });
  });

  it("links an edge drag when requested without changing its flip axis", () => {
    expect(
      lockCornerScaleAspectRatio(
        "e",
        { x: 1, y: 1 },
        { x: -2, y: 1 },
        true,
      ),
    ).toEqual({ x: -2, y: 2 });
  });

  it("leaves unlinked edge drags independent", () => {
    expect(
      lockCornerScaleAspectRatio(
        "e",
        { x: 1, y: 1 },
        { x: -2, y: 1 },
      ),
    ).toEqual({ x: -2, y: 1 });
  });
});

describe("computeFixedHandleOffset", () => {
  const base = {
    anchor: { x: 0.5, y: 0.5 },
    baseSize: { width: 100, height: 50 },
    rotation: 0,
    startScale: { x: 1, y: 1 },
  };

  // Parent-space position of a normalized texture point for a centre-anchored
  // sprite at `position` with `scale` and `rotation`.
  const project = (
    point: { x: number; y: number },
    position: { x: number; y: number },
    scale: { x: number; y: number },
    rotation: number,
  ) => {
    const lx = (point.x - 0.5) * base.baseSize.width * scale.x;
    const ly = (point.y - 0.5) * base.baseSize.height * scale.y;
    return {
      x: position.x + lx * Math.cos(rotation) - ly * Math.sin(rotation),
      y: position.y + lx * Math.sin(rotation) + ly * Math.cos(rotation),
    };
  };

  it("keeps the west edge fixed for an east drag", () => {
    expect(
      computeFixedHandleOffset({
        ...base,
        handle: "e",
        nextScale: { x: 2, y: 1 },
      }),
    ).toEqual({ x: 50, y: 0 });
  });

  it("scales a linked edge drag's other axis about the centre", () => {
    const offset = computeFixedHandleOffset({
      ...base,
      handle: "w",
      nextScale: { x: 2, y: 2 },
    });
    expect(offset.x).toBe(-50);
    expect(offset.y).toBeCloseTo(0);
  });

  it("keeps the opposite corner fixed under rotation and flips", () => {
    const rotation = 0.7;
    const nextScale = { x: -1.5, y: 0.5 };
    const offset = computeFixedHandleOffset({
      ...base,
      handle: "se",
      rotation,
      nextScale,
    });
    const before = project({ x: 0, y: 0 }, { x: 0, y: 0 }, base.startScale, rotation);
    const after = project({ x: 0, y: 0 }, offset, nextScale, rotation);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("does not move position when no handle is dragged", () => {
    const offset = computeFixedHandleOffset({
      ...base,
      handle: null,
      nextScale: { x: 3, y: 3 },
    });
    expect(offset.x).toBeCloseTo(0);
    expect(offset.y).toBeCloseTo(0);
  });
});
