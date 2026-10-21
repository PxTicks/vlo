import { describe, expect, it } from "vitest";
import { resolveMaskEdgeShape } from "../maskEdgeProfile";
import { canShapeMaskUnionFromField, combineMaskFieldQuality } from "../maskFieldComposition";

const EXACT = { band: 15, exactOutside: true };

describe("field composition distance guarantees", () => {
  it("retains the smaller band only for an outside-exact union", () => {
    expect(combineMaskFieldQuality("union", false, EXACT, { ...EXACT, band: 8 }))
      .toEqual({ band: 8, exactOutside: true });
    expect(combineMaskFieldQuality("union", false, EXACT, { ...EXACT, exactOutside: false }).exactOutside)
      .toBe(false);
    expect(combineMaskFieldQuality("intersect", false, EXACT, EXACT).exactOutside).toBe(false);
    expect(combineMaskFieldQuality("subtract", false, EXACT, EXACT).exactOutside).toBe(false);
  });

  it("recognizes the effective union under inverse algebra", () => {
    expect(combineMaskFieldQuality("intersect", true, EXACT, EXACT).exactOutside).toBe(true);
    expect(combineMaskFieldQuality("union", true, EXACT, EXACT).exactOutside).toBe(false);
    expect(combineMaskFieldQuality("subtract", true, EXACT, EXACT).exactOutside).toBe(false);
  });

  it("re-distances a union whenever a ramp reads its inexact inside", () => {
    const grow = (growPx: number) => resolveMaskEdgeShape({ growPx, growInvert: false, feather: null });
    expect(canShapeMaskUnionFromField(grow(4), EXACT)).toBe(true);
    expect(canShapeMaskUnionFromField(grow(-4), EXACT)).toBe(false);
    // The hard edge's anti-aliasing must not expose an internal abutting edge.
    expect(canShapeMaskUnionFromField(grow(0), EXACT)).toBe(false);
    for (const mode of ["hard_outer", "soft_inner", "two_way"] as const) {
      const shape = resolveMaskEdgeShape({
        growPx: 0, growInvert: false, feather: { amountPx: 8, mode, invert: false },
      });
      expect(canShapeMaskUnionFromField(shape, EXACT)).toBe(mode === "hard_outer");
    }
    expect(canShapeMaskUnionFromField(grow(20), EXACT)).toBe(false);
    expect(canShapeMaskUnionFromField(grow(4), { ...EXACT, exactOutside: false })).toBe(false);
  });
});
