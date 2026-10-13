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

interface HandleScaleComputationInput {
  handle: string | null;
  startScale: ScaleLike;
  pointerDelta: Delta;
  rotation: number;
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

export function computeHandleScale({
  handle,
  startScale,
  pointerDelta,
  rotation,
  baseSize,
  minScale,
}: HandleScaleComputationInput): HandleScaleComputationResult {
  const localDelta = toLocalDelta(pointerDelta, rotation);

  const width = Math.max(baseSize.width, 1);
  const height = Math.max(baseSize.height, 1);

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
  startScale: ScaleLike;
  nextScale: ScaleLike;
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
  startScale,
  nextScale,
}: FixedHandleOffsetInput): Delta {
  // 1. Normalized texture coordinate of the point that must stay put.
  const fixedX = handle?.includes("e") ? 0 : handle?.includes("w") ? 1 : anchor.x;
  const fixedY = handle?.includes("s") ? 0 : handle?.includes("n") ? 1 : anchor.y;

  // 2. That point relative to the anchor, in unscaled texture pixels.
  const localX = (fixedX - anchor.x) * baseSize.width;
  const localY = (fixedY - anchor.y) * baseSize.height;

  // 3. How far the scale change would move it, rotated into parent space;
  //    shifting position by this cancels the movement.
  const offsetX = (startScale.x - nextScale.x) * localX;
  const offsetY = (startScale.y - nextScale.y) * localY;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    x: offsetX * cos - offsetY * sin,
    y: offsetX * sin + offsetY * cos,
  };
}

export function getAngleFromPoint(
  point: { x: number; y: number },
  center: { x: number; y: number },
): number {
  return Math.atan2(point.y - center.y, point.x - center.x);
}
