import type { MaskBooleanOperator } from "../../../types/TimelineTypes";
import type { MaskEdgeShape } from "./maskEdgeProfile";

/** What remains a true distance after offsets and boolean composition. */
export interface MaskFieldQuality {
  band: number;
  exactOutside: boolean;
}

/** Only an effective union of outside-exact fields stays exact outside. */
export function combineMaskFieldQuality(
  operator: MaskBooleanOperator,
  inverse: boolean,
  left: MaskFieldQuality,
  right: MaskFieldQuality,
): MaskFieldQuality {
  const union = inverse ? operator === "intersect" : operator === "union";
  return {
    band: Math.min(left.band, right.band),
    exactOutside: union && left.exactOutside && right.exactOutside,
  };
}

/**
 * A union needs no re-distance only when the entire ramp reads its exact
 * outside band. Even a hard edge reads half a texel inside: skipping there
 * can leave an anti-aliased seam where two masks abut.
 */
export function canShapeMaskUnionFromField(
  shape: MaskEdgeShape,
  quality: MaskFieldQuality,
): boolean {
  const low = Math.min(
    shape.offset + shape.sign * shape.rampStart,
    shape.offset + shape.sign * shape.rampEnd,
  );
  return quality.exactOutside && low >= 0 && shape.extent <= quality.band;
}
