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

export function getAngleFromPoint(
  point: { x: number; y: number },
  center: { x: number; y: number },
): number {
  return Math.atan2(point.y - center.y, point.x - center.x);
}
