interface Delta {
  x: number;
  y: number;
}

interface SizeLike {
  width: number;
  height: number;
}

interface ScaleLike {
  x: number;
  y: number;
}

/** Pixi skew angles (radians); layout skew renders as exactly these. */
interface SkewLike {
  x: number;
  y: number;
}

const NO_SKEW: SkewLike = { x: 0, y: 0 };

interface HandleScaleComputationInput {
  handle: string | null;
  /** The sprite's Pixi scale (layout scale lengthened by any skew). */
  startScale: ScaleLike;
  pointerDelta: Delta;
  rotation: number;
  skew?: SkewLike;
  baseSize: SizeLike;
  minScale?: number;
}

interface HandleScaleComputationResult {
  localDelta: Delta;
  scale: ScaleLike;
}

export function toLocalDelta(pointerDelta: Delta, rotation: number): Delta {
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  return {
    x: pointerDelta.x * cos - pointerDelta.y * sin,
    y: pointerDelta.x * sin + pointerDelta.y * cos,
  };
}

/** Undo a CSS-style shear K = [[1, tan x], [tan y, 1]]. */
function unshear(delta: Delta, skew: SkewLike): Delta {
  const tanX = Math.tan(skew.x);
  const tanY = Math.tan(skew.y);
  const determinant = 1 - tanX * tanY;
  if (Math.abs(determinant) < 1e-9) return delta;
  return {
    x: (delta.x - tanX * delta.y) / determinant,
    y: (delta.y - tanY * delta.x) / determinant,
  };
}

export function computeHandleScale({
  handle,
  startScale,
  pointerDelta,
  rotation,
  skew = NO_SKEW,
  baseSize,
  minScale,
}: HandleScaleComputationInput): HandleScaleComputationResult {
  // 1. Pointer movement in the clip's unrotated, unsheared frame.
  const localDelta = unshear(toLocalDelta(pointerDelta, rotation), skew);

  // 2. Pixi scale is the layout scale over cos(other axis's skew), so a layout
  //    width change maps onto it through the same factor.
  const width = Math.max(baseSize.width, 1) * Math.cos(skew.y);
  const height = Math.max(baseSize.height, 1) * Math.cos(skew.x);

  let scaleX = startScale.x;
  let scaleY = startScale.y;

  if (handle?.includes("e")) {
    scaleX = startScale.x + localDelta.x / width;
  }
  if (handle?.includes("w")) {
    scaleX = startScale.x - localDelta.x / width;
  }
  if (handle?.includes("s")) {
    scaleY = startScale.y + localDelta.y / height;
  }
  if (handle?.includes("n")) {
    scaleY = startScale.y - localDelta.y / height;
  }

  if (typeof minScale === "number") {
    scaleX = Math.max(minScale, scaleX);
    scaleY = Math.max(minScale, scaleY);
  }

  return {
    localDelta,
    scale: { x: scaleX, y: scaleY },
  };
}

export function lockCornerScaleAspectRatio(
  handle: string | null,
  startScale: ScaleLike,
  nextScale: ScaleLike,
  forceLinked = false,
): ScaleLike {
  const isCornerHandle = typeof handle === "string" && handle.length === 2;
  if (!isCornerHandle && !forceLinked) {
    return nextScale;
  }

  const ratio = startScale.x / startScale.y;
  if (Math.abs(startScale.x) <= 0.0001 || Math.abs(ratio) <= 0.0001) {
    return nextScale;
  }

  const signOrFallback = (value: number, fallback: number): number =>
    Math.sign(value) || Math.sign(fallback) || 1;
  const isVerticalEdge =
    typeof handle === "string" &&
    handle.length === 1 &&
    (handle === "n" || handle === "s");

  if (isVerticalEdge) {
    return {
      x:
        Math.abs(nextScale.y * ratio) *
        signOrFallback(nextScale.x, startScale.x),
      y: nextScale.y,
    };
  }

  return {
    x: nextScale.x,
    y:
      Math.abs(nextScale.x / ratio) *
      signOrFallback(nextScale.y, startScale.y),
  };
}

interface FixedHandleOffsetInput {
  handle: string | null;
  /** Sprite anchor in normalized texture coordinates (0.5 = centre). */
  anchor: ScaleLike;
  baseSize: SizeLike;
  rotation: number;
  skew?: SkewLike;
  /** Pixi scales before and after the drag. */
  startScale: ScaleLike;
  nextScale: ScaleLike;
}

/** Apply a Pixi local transform's linear part (no translation) to `point`. */
function applyPixiLinear(
  point: Delta,
  rotation: number,
  skew: SkewLike,
  scale: ScaleLike,
): Delta {
  const a = Math.cos(rotation + skew.y) * scale.x;
  const b = Math.sin(rotation + skew.y) * scale.x;
  const c = -Math.sin(rotation - skew.x) * scale.y;
  const d = Math.cos(rotation - skew.x) * scale.y;
  return { x: a * point.x + c * point.y, y: b * point.x + d * point.y };
}

/**
 * Position delta (parent space) that keeps the point opposite the dragged
 * handle fixed while scale changes from `startScale` to `nextScale`.
 *
 * Layout scales about the sprite anchor, so without this offset an edge drag
 * stretches both sides. An axis the handle does not drag keeps scaling about
 * the anchor (e.g. a linked "e" drag grows symmetrically top and bottom).
 */
export function computeFixedHandleOffset({
  handle,
  anchor,
  baseSize,
  rotation,
  skew = NO_SKEW,
  startScale,
  nextScale,
}: FixedHandleOffsetInput): Delta {
  // 1. Normalized texture coordinate of the point that must stay put.
  const fixedX = handle?.includes("e") ? 0 : handle?.includes("w") ? 1 : anchor.x;
  const fixedY = handle?.includes("s") ? 0 : handle?.includes("n") ? 1 : anchor.y;

  // 2. That point relative to the anchor, in unscaled texture pixels.
  const localX = (fixedX - anchor.x) * baseSize.width;
  const localY = (fixedY - anchor.y) * baseSize.height;

  // 3. How far the scale change would move it in parent space; shifting
  //    position by this cancels the movement.
  const local = { x: localX, y: localY };
  const before = applyPixiLinear(local, rotation, skew, startScale);
  const after = applyPixiLinear(local, rotation, skew, nextScale);
  return { x: before.x - after.x, y: before.y - after.y };
}

/** Largest skew the gizmo produces, matching the panel's ±85° limit. */
const MAX_SKEW = (85 * Math.PI) / 180;
const MAX_SKEW_TANGENT = Math.tan(MAX_SKEW);

interface EdgeSkewInput {
  /** An edge handle: n / s shear horizontally, e / w vertically. */
  handle: string;
  pointerDelta: Delta;
  rotation: number;
  /** Skew at drag start (radians). */
  startSkew: SkewLike;
  /** Layout scale (Pixi scale without the skew lengthening). */
  layoutScale: ScaleLike;
  baseSize: SizeLike;
}

interface EdgeSkewResult {
  skew: SkewLike;
  /** Position change that keeps the opposite edge fixed. */
  positionOffset: Delta;
}

/**
 * Ctrl-drag on an edge handle: slide that edge along the pointer while the
 * opposite edge stays put (a CSS-style shear about the centre plus a position
 * shift of half the slide).
 */
export function computeEdgeSkew({
  handle,
  pointerDelta,
  rotation,
  startSkew,
  layoutScale,
  baseSize,
}: EdgeSkewInput): EdgeSkewResult {
  // 1. Pointer movement in the clip's unrotated frame.
  const delta = toLocalDelta(pointerDelta, rotation);
  const clampTangent = (tangent: number) =>
    Math.max(-MAX_SKEW_TANGENT, Math.min(MAX_SKEW_TANGENT, tangent));

  let skew = startSkew;
  let shift: Delta = { x: 0, y: 0 };

  if (handle === "n" || handle === "s") {
    // 2a. Horizontal shear: the dragged edge slides by delta.x; shearing about
    //     the centre moves the two edges oppositely by half the edge height
    //     times the tangent change, so position takes up half the slide.
    const edgeSpan = Math.max(baseSize.height, 1) * layoutScale.y;
    const direction = handle === "n" ? -1 : 1;
    const tangent = clampTangent(
      Math.tan(startSkew.x) + (direction * delta.x) / edgeSpan,
    );
    const applied = (tangent - Math.tan(startSkew.x)) * edgeSpan * direction;
    skew = { x: Math.atan(tangent), y: startSkew.y };
    shift = { x: applied / 2, y: 0 };
  } else if (handle === "e" || handle === "w") {
    // 2b. Vertical shear, the same along the other axis.
    const edgeSpan = Math.max(baseSize.width, 1) * layoutScale.x;
    const direction = handle === "w" ? -1 : 1;
    const tangent = clampTangent(
      Math.tan(startSkew.y) + (direction * delta.y) / edgeSpan,
    );
    const applied = (tangent - Math.tan(startSkew.y)) * edgeSpan * direction;
    skew = { x: startSkew.x, y: Math.atan(tangent) };
    shift = { x: 0, y: applied / 2 };
  }

  // 3. Rotate the position shift back into parent space.
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    skew,
    positionOffset: {
      x: shift.x * cos - shift.y * sin,
      y: shift.x * sin + shift.y * cos,
    },
  };
}

export function getAngleFromPoint(
  point: { x: number; y: number },
  center: { x: number; y: number },
): number {
  return Math.atan2(point.y - center.y, point.x - center.x);
}
