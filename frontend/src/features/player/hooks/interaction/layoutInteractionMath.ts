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

export function getAngleFromPoint(
  point: { x: number; y: number },
  center: { x: number; y: number },
): number {
  return Math.atan2(point.y - center.y, point.x - center.x);
}
