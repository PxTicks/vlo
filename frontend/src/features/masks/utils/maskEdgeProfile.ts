/**
 * Pure maths for distance-field mask edges (docs/mask-distance-field-plan.md).
 *
 * Every edge op is a function of the mask's signed distance `d` (texels,
 * negative inside): grow offsets it, invert flips it, and a feather is a
 * smoothstep ramp over an interval of the offset field. This module turns
 * the authored edge ops into the shaping-pass uniforms and decides how far
 * the jump flood has to search.
 */

export type MaskFeatherMode = "hard_outer" | "soft_inner" | "two_way";

export interface MaskEdgeOps {
  /** Pixels to grow by; negative shrinks. */
  growPx: number;
  /** Grow the inverse instead, which shrinks the mask by `growPx`. */
  growInvert: boolean;
  feather: {
    /** Ramp width in pixels. */
    amountPx: number;
    mode: MaskFeatherMode;
    /** Feather the inverse instead, which mirrors the ramp across the edge. */
    invert: boolean;
  } | null;
}

/** Shaping-pass uniforms, in field texels. */
export interface MaskEdgeShape {
  /** Subtracted from the signed distance: positive grows. */
  offset: number;
  /** Applied after the offset; -1 evaluates the ramp on the inverse mask. */
  sign: 1 | -1;
  /** Coverage is 1 at `rampStart` and 0 at `rampEnd` of the signed edge. */
  rampStart: number;
  rampEnd: number;
  invertOutput: boolean;
  /** Distances must be exact up to this many texels from the boundary. */
  reach: number;
}

/** The narrowest ramp drawn: one texel, an anti-aliased hard edge. */
const MIN_RAMP_WIDTH = 1;

/** Largest packed seed coordinate; 65535 marks "no seed". */
const MAX_PACKED_SEED_COORDINATE = 65534;
const MAX_SEED_FRACTION_BITS = 4;

export function hasMaskEdgeOps(ops: MaskEdgeOps): boolean {
  return (
    (Number.isFinite(ops.growPx) && ops.growPx !== 0) ||
    (!!ops.feather &&
      Number.isFinite(ops.feather.amountPx) &&
      ops.feather.amountPx > 0)
  );
}

function featherInterval(
  mode: MaskFeatherMode,
  width: number,
): [number, number] {
  switch (mode) {
    case "hard_outer":
      return [0, width];
    case "soft_inner":
      return [-width, 0];
    case "two_way":
      return [-width / 2, width / 2];
  }
}

/**
 * Resolve edge ops to shaping uniforms. `texelsPerPixel` converts authored
 * pixels into the field texture's texels.
 */
export function resolveMaskEdgeShape(
  ops: MaskEdgeOps,
  texelsPerPixel = 1,
): MaskEdgeShape {
  const scale = Number.isFinite(texelsPerPixel) && texelsPerPixel > 0
    ? texelsPerPixel
    : 1;
  const grow = Number.isFinite(ops.growPx) ? ops.growPx * scale : 0;
  const offset = ops.growInvert ? -grow : grow;

  const featherWidth =
    ops.feather && Number.isFinite(ops.feather.amountPx)
      ? Math.max(0, ops.feather.amountPx) * scale
      : 0;
  const feather = featherWidth > 0 ? ops.feather : null;

  let [rampStart, rampEnd] = feather
    ? featherInterval(feather.mode, featherWidth)
    : [0, 0];
  // A ramp narrower than a texel would alias; widen it about its centre so
  // a feather shrinking to zero lands exactly on the anti-aliased hard edge.
  if (rampEnd - rampStart < MIN_RAMP_WIDTH) {
    const centre = (rampStart + rampEnd) / 2;
    rampStart = centre - MIN_RAMP_WIDTH / 2;
    rampEnd = centre + MIN_RAMP_WIDTH / 2;
  }

  const invert = feather?.invert ?? false;
  return {
    offset,
    sign: invert ? -1 : 1,
    rampStart,
    rampEnd,
    invertOutput: invert,
    reach: Math.abs(offset) + Math.max(Math.abs(rampStart), Math.abs(rampEnd)) + 1,
  };
}

/** The same shape with its output coverage complemented. */
export function invertMaskEdgeShape(shape: MaskEdgeShape): MaskEdgeShape {
  return { ...shape, invertOutput: !shape.invertOutput };
}

/**
 * Jump-flood step sizes for a bounded search ("JFA+1"): halving from the
 * first power of two covering `reach`, then one extra unit step that repairs
 * most of the flood's rare wrong-seed picks.
 */
export function buildJumpFloodSteps(
  reach: number,
  maxDimension: number,
): number[] {
  const dimension = Math.max(1, Math.ceil(maxDimension));
  const boundedReach = Math.min(Math.max(1, Math.ceil(reach)), dimension);
  // A step at or beyond the texture size never lands on a texel.
  const largestUsefulStep = 2 ** Math.max(0, Math.ceil(Math.log2(dimension)) - 1);
  let step = Math.min(
    2 ** Math.ceil(Math.log2(boundedReach)),
    largestUsefulStep,
  );
  const steps: number[] = [];
  while (step >= 1) {
    steps.push(step);
    step /= 2;
  }
  steps.push(1);
  return steps;
}

/**
 * Fixed-point scale for packing seed coordinates into 16 bits per axis:
 * the most fractional bits (up to 1/16 texel) that still fit the texture.
 */
export function resolveSeedCoordinateScale(maxDimension: number): number {
  const limit = Math.max(1, Math.ceil(maxDimension)) + 1;
  const fractionBits = Math.floor(
    Math.log2(MAX_PACKED_SEED_COORDINATE / limit),
  );
  return 2 ** Math.min(MAX_SEED_FRACTION_BITS, Math.max(0, fractionBits));
}
