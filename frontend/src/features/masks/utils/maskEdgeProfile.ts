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
  /** The farthest distance from the boundary the ramp reads, in texels. */
  extent: number;
  /** A jump flood must be exact this far out: the extent plus a texel. */
  reach: number;
}

/** The narrowest ramp drawn: one texel, an anti-aliased hard edge. */
const MIN_RAMP_WIDTH = 1;
/**
 * How far a ramp may read into the inexact side of an offset edge: half the
 * one-texel anti-aliased edge, which straddles every edge.
 */
const OFFSET_EXACT_TOLERANCE = MIN_RAMP_WIDTH / 2;

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
  return withExtent({
    offset,
    sign: invert ? -1 : 1,
    rampStart,
    rampEnd,
    invertOutput: invert,
  });
}

function withExtent(
  shape: Omit<MaskEdgeShape, "extent" | "reach">,
): MaskEdgeShape {
  const extent =
    Math.abs(shape.offset) +
    Math.max(Math.abs(shape.rampStart), Math.abs(shape.rampEnd));
  return { ...shape, extent, reach: extent + 1 };
}

/** The same shape with its output coverage complemented. */
export function invertMaskEdgeShape(shape: MaskEdgeShape): MaskEdgeShape {
  return { ...shape, invertOutput: !shape.invertOutput };
}

/** The signed-distance interval a shape's ramp reads, in its input field. */
function readInterval(shape: MaskEdgeShape): [number, number] {
  const first = shape.offset + shape.sign * shape.rampStart;
  const second = shape.offset + shape.sign * shape.rampEnd;
  return [Math.min(first, second), Math.max(first, second)];
}

/**
 * An offset field d - o is the true distance to the offset mask only on one
 * side of its edge: outside a grow (o > 0), inside a shrink (o < 0). Across
 * the edge it under-reads, and once a shrink has erased a feature it still
 * remembers it. A shape is exact when its ramp reads only the true side.
 */
function readsOnlyExactSide(shape: MaskEdgeShape): boolean {
  const [low, high] = readInterval(shape);
  if (shape.offset > 0) {
    return low >= shape.offset - OFFSET_EXACT_TOLERANCE;
  }
  if (shape.offset < 0) {
    return high <= shape.offset + OFFSET_EXACT_TOLERANCE;
  }
  return true;
}

/**
 * Edge ops as exact shaping stages. A grow and a feather are one shape when
 * the feather's ramp stays on the grown edge's exact side. Otherwise (a
 * feather reaching into a grown mask, or out of a shrunk one) the grown
 * mask is drawn first and re-distanced for the feather.
 */
export function planMaskEdgeStages(
  ops: MaskEdgeOps,
  texelsPerPixel = 1,
): MaskEdgeShape[] {
  const combined = resolveMaskEdgeShape(ops, texelsPerPixel);
  if (!ops.feather || readsOnlyExactSide(combined)) {
    return [combined];
  }
  return [
    resolveMaskEdgeShape({ ...ops, feather: null }, texelsPerPixel),
    resolveMaskEdgeShape(
      { growPx: 0, growInvert: false, feather: ops.feather },
      texelsPerPixel,
    ),
  ];
}

/**
 * Re-express a single-stage shape applied to a leaf mask (itself grown by
 * `growTexels`, then optionally inverted) as one shape on the leaf's original
 * distance field, so a single-leaf expression can be shaped straight from
 * that field. Null when that would not be exact.
 *
 * The leaf's field is sigma * (d - g), sigma = -1 when inverted; the shape
 * evaluates s * (sigma * (d - g) - o), which is (s * sigma) * (d - (g + sigma * o)).
 * Two offsets only add when they point the same way: a shrink then a grow
 * is an opening, which can erase features for good, not a no-op.
 */
export function composeMaskEdgeShapeOverLeaf(
  shape: MaskEdgeShape,
  leaf: { growTexels: number; inverted: boolean },
): MaskEdgeShape | null {
  const sigma = leaf.inverted ? -1 : 1;
  const growTexels = Number.isFinite(leaf.growTexels) ? leaf.growTexels : 0;
  const compositeOffset = sigma * shape.offset;
  if (growTexels * compositeOffset < 0) {
    return null;
  }
  const composed = withExtent({
    offset: growTexels + compositeOffset,
    sign: (shape.sign * sigma) as 1 | -1,
    rampStart: shape.rampStart,
    rampEnd: shape.rampEnd,
    invertOutput: shape.invertOutput,
  });
  return readsOnlyExactSide(composed) ? composed : null;
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
