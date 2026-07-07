import type { BoundingBox, Point2D } from "../types";

export type MaskPixelChannel = "red" | "alpha" | "luma";

export interface MaskPixelBoundsOptions {
  threshold?: number;
  channel?: MaskPixelChannel;
}

export interface AspectRatioBoxOptions {
  minWidth?: number;
  minHeight?: number;
}

export interface BoxTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

function isFinitePoint(point: Point2D): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function normalizeBox(box: BoundingBox): BoundingBox | null {
  if (
    !Number.isFinite(box.x) ||
    !Number.isFinite(box.y) ||
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height)
  ) {
    return null;
  }
  const minX = Math.min(box.x, box.x + box.width);
  const minY = Math.min(box.y, box.y + box.height);
  const maxX = Math.max(box.x, box.x + box.width);
  const maxY = Math.max(box.y, box.y + box.height);
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

export function createBoundingBoxFromPoints(
  points: readonly Point2D[],
): BoundingBox | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  points.forEach((point) => {
    if (!isFinitePoint(point)) return;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  });

  if (
    minX === Number.POSITIVE_INFINITY ||
    minY === Number.POSITIVE_INFINITY ||
    maxX === Number.NEGATIVE_INFINITY ||
    maxY === Number.NEGATIVE_INFINITY
  ) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function getBoundingBoxCentroid(box: BoundingBox): Point2D {
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

export function createAspectRatioFixedBoundingBox(
  box: BoundingBox,
  aspectRatio: number,
  options: AspectRatioBoxOptions = {},
): BoundingBox {
  const normalized = normalizeBox(box) ?? {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  };
  const safeAspectRatio =
    Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  const center = getBoundingBoxCentroid(normalized);
  const minWidth = Math.max(0, options.minWidth ?? 0);
  const minHeight = Math.max(0, options.minHeight ?? 0);

  let width = Math.max(normalized.width, minWidth);
  let height = Math.max(normalized.height, minHeight);

  if (width === 0 && height === 0) {
    width = Math.max(1, minWidth);
    height = Math.max(width / safeAspectRatio, minHeight);
  } else if (height === 0) {
    height = width / safeAspectRatio;
  } else if (width === 0) {
    width = height * safeAspectRatio;
  }

  const currentAspectRatio = width / height;
  if (currentAspectRatio > safeAspectRatio) {
    height = width / safeAspectRatio;
  } else {
    width = height * safeAspectRatio;
  }

  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  };
}

function readMaskPixelValue(
  pixels: ArrayLike<number>,
  offset: number,
  channel: MaskPixelChannel,
): number {
  const red = pixels[offset] ?? 0;
  const green = pixels[offset + 1] ?? 0;
  const blue = pixels[offset + 2] ?? 0;
  const alpha = pixels[offset + 3] ?? 0;

  if (channel === "alpha") {
    return alpha;
  }
  if (channel === "luma") {
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  }
  return red;
}

export function createBoundingBoxFromMaskPixels(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  options: MaskPixelBoundsOptions = {},
): BoundingBox | null {
  const safeWidth = Math.max(0, Math.floor(width));
  const safeHeight = Math.max(0, Math.floor(height));
  if (safeWidth <= 0 || safeHeight <= 0) {
    return null;
  }

  const threshold = options.threshold ?? 0;
  const channel = options.channel ?? "red";
  let minX = safeWidth;
  let minY = safeHeight;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      const offset = (y * safeWidth + x) * 4;
      if (readMaskPixelValue(pixels, offset, channel) <= threshold) {
        continue;
      }
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

export function getBoundingBoxCorners(box: BoundingBox): Point2D[] {
  const normalized = normalizeBox(box);
  if (!normalized) return [];
  const right = normalized.x + normalized.width;
  const bottom = normalized.y + normalized.height;
  return [
    { x: normalized.x, y: normalized.y },
    { x: right, y: normalized.y },
    { x: right, y: bottom },
    { x: normalized.x, y: bottom },
  ];
}

export function transformPoint(point: Point2D, transform: BoxTransform): Point2D {
  const scaledX = point.x * transform.scaleX;
  const scaledY = point.y * transform.scaleY;
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return {
    x: transform.x + scaledX * cos - scaledY * sin,
    y: transform.y + scaledX * sin + scaledY * cos,
  };
}

export function transformBoundingBox(
  box: BoundingBox,
  transform: BoxTransform,
): BoundingBox | null {
  return createBoundingBoxFromPoints(
    getBoundingBoxCorners(box).map((point) => transformPoint(point, transform)),
  );
}
