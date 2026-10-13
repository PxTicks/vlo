import { describe, expect, it } from "vitest";
import {
  computeEdgeSkew,
  computeFixedHandleOffset,
  computeHandleScale,
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

describe("skewed gizmo maths", () => {
  const baseSize = { width: 100, height: 50 };

  // Parent-space point of a normalized texture point for a centre-anchored
  // sprite drawn with Pixi's transform (rotation r, skew k, Pixi scale s).
  const projectPixi = (
    point: { x: number; y: number },
    position: { x: number; y: number },
    rotation: number,
    skew: { x: number; y: number },
    scale: { x: number; y: number },
  ) => {
    const lx = (point.x - 0.5) * baseSize.width;
    const ly = (point.y - 0.5) * baseSize.height;
    const a = Math.cos(rotation + skew.y) * scale.x;
    const b = Math.sin(rotation + skew.y) * scale.x;
    const c = -Math.sin(rotation - skew.x) * scale.y;
    const d = Math.cos(rotation - skew.x) * scale.y;
    return { x: position.x + a * lx + c * ly, y: position.y + b * lx + d * ly };
  };

  it("keeps the opposite corner fixed when scaling a skewed clip", () => {
    const rotation = 0.3;
    const skew = { x: 0.4, y: -0.2 };
    const startScale = { x: 1.2, y: 0.8 };
    const scaled = computeHandleScale({
      handle: "se",
      startScale,
      pointerDelta: { x: 30, y: 12 },
      rotation,
      skew,
      baseSize,
    });
    const offset = computeFixedHandleOffset({
      handle: "se",
      anchor: { x: 0.5, y: 0.5 },
      baseSize,
      rotation,
      skew,
      startScale,
      nextScale: scaled.scale,
    });

    const before = projectPixi({ x: 0, y: 0 }, { x: 0, y: 0 }, rotation, skew, startScale);
    const after = projectPixi({ x: 0, y: 0 }, offset, rotation, skew, scaled.scale);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("drags the east edge with the pointer on a sheared clip", () => {
    const skew = { x: 0.5, y: 0 };
    const startScale = { x: 1, y: 1 / Math.cos(0.5) };
    // Pointer moves straight out along the (unsheared) x axis.
    const scaled = computeHandleScale({
      handle: "e",
      startScale,
      pointerDelta: { x: 20, y: 0 },
      rotation: 0,
      skew,
      baseSize,
    });
    expect(scaled.scale.x).toBeCloseTo(1.2);
    expect(scaled.scale.y).toBeCloseTo(startScale.y);
  });

  it.each(["n", "s", "e", "w"])(
    "slides the %s edge and keeps the opposite edge fixed",
    (handle) => {
      const rotation = 0.6;
      const startSkew = { x: 0.1, y: -0.15 };
      const layoutScale = { x: 1.5, y: 0.75 };
      const pointerDelta = { x: 14, y: -9 };
      const result = computeEdgeSkew({
        handle,
        pointerDelta,
        rotation,
        startSkew,
        layoutScale,
        baseSize,
      });
      const pixiScale = (skew: { x: number; y: number }) => ({
        x: layoutScale.x / Math.cos(skew.y),
        y: layoutScale.y / Math.cos(skew.x),
      });

      const opposite = { n: { x: 0.5, y: 1 }, s: { x: 0.5, y: 0 }, e: { x: 0, y: 0.5 }, w: { x: 1, y: 0.5 } }[handle]!;
      const before = projectPixi(opposite, { x: 0, y: 0 }, rotation, startSkew, pixiScale(startSkew));
      const after = projectPixi(
        opposite,
        result.positionOffset,
        rotation,
        result.skew,
        pixiScale(result.skew),
      );
      expect(after.x).toBeCloseTo(before.x);
      expect(after.y).toBeCloseTo(before.y);

      // Only the matching shear axis changes.
      if (handle === "n" || handle === "s") {
        expect(result.skew.y).toBe(startSkew.y);
        expect(result.skew.x).not.toBeCloseTo(startSkew.x);
      } else {
        expect(result.skew.x).toBe(startSkew.x);
        expect(result.skew.y).not.toBeCloseTo(startSkew.y);
      }
    },
  );

  it("slides the dragged edge by the pointer's along-edge movement", () => {
    // Unrotated, unskewed: dragging the top edge 20 px right shears it 20 px.
    const result = computeEdgeSkew({
      handle: "n",
      pointerDelta: { x: 20, y: 7 },
      rotation: 0,
      startSkew: { x: 0, y: 0 },
      layoutScale: { x: 1, y: 1 },
      baseSize,
    });
    expect(Math.tan(result.skew.x)).toBeCloseTo(-20 / 50);
    expect(result.positionOffset).toEqual({ x: 10, y: 0 });
  });

  it("caps the shear at 85 degrees", () => {
    const result = computeEdgeSkew({
      handle: "s",
      pointerDelta: { x: 1e6, y: 0 },
      rotation: 0,
      startSkew: { x: 0, y: 0 },
      layoutScale: { x: 1, y: 1 },
      baseSize,
    });
    expect(result.skew.x).toBeCloseTo((85 * Math.PI) / 180);
  });
});
