import { describe, expect, it } from "vitest";
import {
  buildJumpFloodSteps,
  composeMaskEdgeShapeOverLeaf,
  hasMaskEdgeOps,
  planMaskEdgeStages,
  invertMaskEdgeShape,
  resolveMaskEdgeShape,
  resolveSeedCoordinateScale,
  type MaskEdgeOps,
} from "../maskEdgeProfile";

const NO_OPS: MaskEdgeOps = { growPx: 0, growInvert: false, feather: null };

/** Coverage the shaping shader produces at signed distance `d`. */
function coverageAt(ops: MaskEdgeOps, d: number): number {
  const shape = resolveMaskEdgeShape(ops);
  const edge = shape.sign * (d - shape.offset);
  const t = Math.min(
    1,
    Math.max(0, (edge - shape.rampStart) / (shape.rampEnd - shape.rampStart)),
  );
  const coverage = 1 - t * t * (3 - 2 * t);
  return shape.invertOutput ? 1 - coverage : coverage;
}

describe("hasMaskEdgeOps", () => {
  it("treats shrink as an edge op", () => {
    expect(hasMaskEdgeOps(NO_OPS)).toBe(false);
    expect(hasMaskEdgeOps({ ...NO_OPS, growPx: -4 })).toBe(true);
    expect(
      hasMaskEdgeOps({
        ...NO_OPS,
        feather: { amountPx: 0, mode: "hard_outer", invert: false },
      }),
    ).toBe(false);
    expect(
      hasMaskEdgeOps({
        ...NO_OPS,
        feather: { amountPx: 3, mode: "hard_outer", invert: false },
      }),
    ).toBe(true);
  });
});

describe("resolveMaskEdgeShape", () => {
  it("grows by exactly the authored pixels with a one-texel anti-aliased edge", () => {
    const ops = { ...NO_OPS, growPx: 10 };
    expect(coverageAt(ops, 9.5)).toBe(1);
    expect(coverageAt(ops, 10)).toBeCloseTo(0.5);
    expect(coverageAt(ops, 10.5)).toBe(0);
  });

  it("shrinks for negative grow and for grow on the inverse", () => {
    expect(coverageAt({ ...NO_OPS, growPx: -6 }, -6)).toBeCloseTo(0.5);
    expect(coverageAt({ ...NO_OPS, growPx: 6, growInvert: true }, -6)).toBeCloseTo(0.5);
    expect(coverageAt({ ...NO_OPS, growPx: 6, growInvert: true }, -5)).toBe(0);
  });

  it("places each feather mode's ramp on its side of the grown edge", () => {
    const feather = (mode: "hard_outer" | "soft_inner" | "two_way") => ({
      ...NO_OPS,
      growPx: 2,
      feather: { amountPx: 8, mode, invert: false },
    });
    // hard_outer: solid to the grown edge, then 8 px outward.
    expect(coverageAt(feather("hard_outer"), 2)).toBe(1);
    expect(coverageAt(feather("hard_outer"), 6)).toBeCloseTo(0.5);
    expect(coverageAt(feather("hard_outer"), 10)).toBe(0);
    // soft_inner: reaches 0 at the grown edge, 1 at 8 px inside it.
    expect(coverageAt(feather("soft_inner"), -6)).toBe(1);
    expect(coverageAt(feather("soft_inner"), -2)).toBeCloseTo(0.5);
    expect(coverageAt(feather("soft_inner"), 2)).toBe(0);
    // two_way: centred on the grown edge.
    expect(coverageAt(feather("two_way"), -2)).toBe(1);
    expect(coverageAt(feather("two_way"), 2)).toBeCloseTo(0.5);
    expect(coverageAt(feather("two_way"), 6)).toBe(0);
  });

  it("mirrors an inverted feather across the edge", () => {
    const ops: MaskEdgeOps = {
      ...NO_OPS,
      feather: { amountPx: 8, mode: "hard_outer", invert: true },
    };
    // The inverse's outward ramp lies inside the mask.
    expect(coverageAt(ops, 0)).toBe(0);
    expect(coverageAt(ops, -4)).toBeCloseTo(0.5);
    expect(coverageAt(ops, -8)).toBe(1);
    expect(coverageAt(ops, 4)).toBe(0);
  });

  it("converges on the hard edge as the feather shrinks to zero", () => {
    const tiny: MaskEdgeOps = {
      ...NO_OPS,
      feather: { amountPx: 0.001, mode: "hard_outer", invert: false },
    };
    for (const d of [-0.5, -0.25, 0, 0.25, 0.5]) {
      expect(coverageAt(tiny, d)).toBeCloseTo(coverageAt({ ...NO_OPS, growPx: 1e-9 }, d), 2);
    }
  });

  it("converts pixels to field texels", () => {
    const shape = resolveMaskEdgeShape(
      { growPx: 10, growInvert: false, feather: { amountPx: 4, mode: "hard_outer", invert: false } },
      0.5,
    );
    expect(shape.offset).toBe(5);
    expect(shape.rampEnd).toBe(2);
  });

  it("reaches as far as the grown ramp extends", () => {
    expect(resolveMaskEdgeShape({ ...NO_OPS, growPx: 10 }).reach).toBe(11.5);
    expect(
      resolveMaskEdgeShape({
        growPx: -10,
        growInvert: false,
        feather: { amountPx: 20, mode: "soft_inner", invert: false },
      }).reach,
    ).toBe(31);
  });

  it("inverts output without touching the edge position", () => {
    const shape = resolveMaskEdgeShape({ ...NO_OPS, growPx: 3 });
    const inverted = invertMaskEdgeShape(shape);
    expect(inverted).toEqual({ ...shape, invertOutput: true });
  });
});

describe("buildJumpFloodSteps", () => {
  it("halves from the first power of two covering the reach, then repeats 1", () => {
    expect(buildJumpFloodSteps(16, 1920)).toEqual([16, 8, 4, 2, 1, 1]);
    expect(buildJumpFloodSteps(17, 1920)).toEqual([32, 16, 8, 4, 2, 1, 1]);
    expect(buildJumpFloodSteps(1.5, 1920)).toEqual([2, 1, 1]);
    expect(buildJumpFloodSteps(0.2, 1920)).toEqual([1, 1]);
  });

  it("never steps past the texture", () => {
    expect(buildJumpFloodSteps(10_000, 1920)).toEqual([
      1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1, 1,
    ]);
    expect(buildJumpFloodSteps(40, 32)[0]).toBe(16);
  });
});

describe("resolveSeedCoordinateScale", () => {
  it("keeps 1/16 texel precision up to 4K and fits every coordinate in 16 bits", () => {
    expect(resolveSeedCoordinateScale(1920)).toBe(16);
    expect(resolveSeedCoordinateScale(3840)).toBe(16);
    expect(resolveSeedCoordinateScale(4096)).toBe(8);
    for (const size of [1, 255, 1920, 4095, 4096, 8192, 16384]) {
      const scale = resolveSeedCoordinateScale(size);
      expect((size + 1) * scale).toBeLessThanOrEqual(65534);
    }
  });
});

/** Coverage a shape produces at signed distance `d` of its input field. */
function shapeAt(shape: ReturnType<typeof resolveMaskEdgeShape>, d: number): number {
  const edge = shape.sign * (d - shape.offset);
  const t = Math.min(
    1,
    Math.max(0, (edge - shape.rampStart) / (shape.rampEnd - shape.rampStart)),
  );
  const coverage = 1 - t * t * (3 - 2 * t);
  return shape.invertOutput ? 1 - coverage : coverage;
}

describe("planMaskEdgeStages", () => {
  const feathered = (
    growPx: number,
    mode: "hard_outer" | "soft_inner" | "two_way",
    invert = false,
  ): MaskEdgeOps => ({
    growPx,
    growInvert: false,
    feather: { amountPx: 8, mode, invert },
  });

  it("keeps a grow, or a feather on the grown edge's exact side, as one shape", () => {
    expect(planMaskEdgeStages({ ...NO_OPS, growPx: 6 })).toHaveLength(1);
    expect(planMaskEdgeStages({ ...NO_OPS, growPx: -6 })).toHaveLength(1);
    // A grown mask is exact outside; a shrunk one inside.
    expect(planMaskEdgeStages(feathered(4, "hard_outer"))).toHaveLength(1);
    expect(planMaskEdgeStages(feathered(-4, "soft_inner"))).toHaveLength(1);
    expect(planMaskEdgeStages(feathered(0, "two_way"))).toHaveLength(1);
  });

  it("re-distances the grown mask when the feather reads across its edge", () => {
    for (const ops of [
      feathered(4, "soft_inner"),
      feathered(-4, "hard_outer"),
      feathered(4, "two_way"),
      // An inverted outer feather reaches inward.
      feathered(4, "hard_outer", true),
    ]) {
      const stages = planMaskEdgeStages(ops);
      expect(stages).toHaveLength(2);
      expect(stages[0]).toEqual(resolveMaskEdgeShape({ ...ops, feather: null }));
      expect(stages[1]).toEqual(
        resolveMaskEdgeShape({ growPx: 0, growInvert: false, feather: ops.feather }),
      );
    }
  });
});

describe("composeMaskEdgeShapeOverLeaf", () => {
  it("matches shaping the grown leaf's own field when the offsets agree", () => {
    const composite = resolveMaskEdgeShape({
      growPx: 3,
      growInvert: false,
      feather: { amountPx: 6, mode: "hard_outer", invert: false },
    });
    const cases = [
      { growTexels: 4, inverted: false },
      // Shrunk 4 then inverted: the composite grows the inverse, which
      // shrinks the original further, in the same direction.
      { growTexels: -4, inverted: true },
    ];
    for (const leaf of cases) {
      const composed = composeMaskEdgeShapeOverLeaf(composite, leaf);
      expect(composed).not.toBeNull();
      for (let d = -20; d <= 20; d += 0.25) {
        const leafField = (leaf.inverted ? -1 : 1) * (d - leaf.growTexels);
        expect(shapeAt(composed!, d)).toBeCloseTo(shapeAt(composite, leafField), 9);
      }
    }
  });

  it("refuses offsets in opposite directions: a shrink then a grow can erase", () => {
    // A 4 px disc shrunk 6 px is gone; growing it 6 px must not bring it back.
    const composite = resolveMaskEdgeShape({ ...NO_OPS, growPx: 6 });
    expect(composeMaskEdgeShapeOverLeaf(composite, { growTexels: -6, inverted: false })).toBeNull();
    // Grown, then inverted and grown again: the second grow shrinks the original.
    expect(composeMaskEdgeShapeOverLeaf(composite, { growTexels: 5, inverted: true })).toBeNull();
  });

  it("refuses a ramp that reads across the combined offset's edge", () => {
    const innerFeather = resolveMaskEdgeShape({
      ...NO_OPS,
      feather: { amountPx: 8, mode: "soft_inner", invert: false },
    });
    expect(composeMaskEdgeShapeOverLeaf(innerFeather, { growTexels: 4, inverted: false })).toBeNull();
    expect(composeMaskEdgeShapeOverLeaf(innerFeather, { growTexels: -4, inverted: false })).not.toBeNull();
  });

  it("measures how far the composed ramp reads", () => {
    const composite = resolveMaskEdgeShape({ ...NO_OPS, growPx: 3 });
    expect(composite.extent).toBe(3.5);
    const composed = composeMaskEdgeShapeOverLeaf(composite, {
      growTexels: 5,
      inverted: false,
    });
    expect(composed?.offset).toBe(8);
    expect(composed?.extent).toBe(8.5);
    expect(composed?.reach).toBe(9.5);
  });
});
