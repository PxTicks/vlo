import { describe, expect, it } from "vitest";
import {
  affineStretch,
  multiplyAffine,
  quadCoversRect,
  resolveAssetFieldGeometry,
  type Affine2D,
} from "../maskAssetGeometry";

const IDENTITY: Affine2D = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function transform(options: {
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  tx?: number;
  ty?: number;
}): Affine2D {
  const { scaleX = 1, scaleY = 1, rotation = 0, tx = 0, ty = 0 } = options;
  return {
    a: Math.cos(rotation) * scaleX,
    b: Math.sin(rotation) * scaleX,
    c: -Math.sin(rotation) * scaleY,
    d: Math.cos(rotation) * scaleY,
    tx,
    ty,
  };
}

/** A 100x100 asset sprite anchored at its centre. */
const BOUNDS = { minX: -50, minY: -50, maxX: 50, maxY: 50 };
const CONTENT = { width: 100, height: 100 };

describe("affineStretch", () => {
  it("is the scale of a similarity and the axis scales otherwise", () => {
    expect(affineStretch(transform({ scaleX: 2, scaleY: 2, rotation: 0.7 }))).toEqual({
      max: expect.closeTo(2, 9),
      min: expect.closeTo(2, 9),
    });
    expect(affineStretch(transform({ scaleX: 2, scaleY: 0.5, rotation: 0.3 }))).toEqual({
      max: expect.closeTo(2, 9),
      min: expect.closeTo(0.5, 9),
    });
  });
});

describe("multiplyAffine", () => {
  it("applies the right transform first", () => {
    const shift = { ...IDENTITY, tx: 10 };
    const double = transform({ scaleX: 2, scaleY: 2 });
    expect(multiplyAffine(shift, double).tx).toBe(10);
    expect(multiplyAffine(double, shift).tx).toBe(20);
  });
});

describe("quadCoversRect", () => {
  it("accepts a sprite that fills the content and rejects one that falls short", () => {
    const centred = transform({ tx: 50, ty: 50 });
    expect(quadCoversRect(centred, BOUNDS, 100, 100)).toBe(true);
    expect(quadCoversRect(transform({ tx: 50, ty: 50, scaleX: 0.32, scaleY: 0.32 }), BOUNDS, 100, 100)).toBe(false);
    expect(quadCoversRect(transform({ tx: 60, ty: 50 }), BOUNDS, 100, 100)).toBe(false);
    expect(quadCoversRect(transform({ tx: 50, ty: 50, scaleX: 2, scaleY: 2, rotation: 0.4 }), BOUNDS, 100, 100)).toBe(true);
  });
});

describe("resolveAssetFieldGeometry", () => {
  it("keeps the band's distances under a covering similarity", () => {
    expect(
      resolveAssetFieldGeometry(transform({ tx: 50, ty: 50, scaleX: 1.5, scaleY: 1.5, rotation: 0.2 }), BOUNDS, CONTENT),
    ).toEqual({ coverageScale: expect.closeTo(1.5, 9), distanceScale: expect.closeTo(1.5, 9) });
  });

  it("drops the band's distances under non-uniform scale", () => {
    const geometry = resolveAssetFieldGeometry(
      transform({ tx: 50, ty: 50, scaleX: 2, scaleY: 1.5 }),
      BOUNDS,
      CONTENT,
    );
    expect(geometry.distanceScale).toBeNull();
    // The decoded edge follows the smallest stretch, never narrower than a texel.
    expect(geometry.coverageScale).toBeCloseTo(1.5, 9);
  });

  it("drops the band's distances when the sprite leaves content uncovered", () => {
    const geometry = resolveAssetFieldGeometry(
      transform({ tx: 50, ty: 50, scaleX: 0.32, scaleY: 0.32 }),
      BOUNDS,
      CONTENT,
    );
    expect(geometry.distanceScale).toBeNull();
    expect(geometry.coverageScale).toBeCloseTo(0.32, 9);
  });
});
