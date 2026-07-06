/**
 * Frontend port of the backend mask-crop bounding-box math
 * (`backend/services/gen_pipeline/processors/utils/mask_crop.py`).
 *
 * Given per-frame mask coverage, computes the tightest union bounding box,
 * expands it to a target aspect ratio, applies dilation (padding), and
 * clamps/shifts to stay within the container. Parity with the backend is
 * enforced by shared fixtures under `shared/fixtures/generation-processing/`.
 */

import { pythonRound } from "./aspectRatioProcessing";

/** `(x1, y1, x2, y2)` pixel box, x2/y2 exclusive. */
export type MaskBounds = [number, number, number, number];

/**
 * Mask MP4s are analyzed as bright-on-dark red-channel video. After
 * H.264/YUV roundtrips, nominal white often decodes near studio-range 235
 * while black backgrounds lift slightly above 0; this cutoff keeps bright
 * mask content positive without letting background noise dominate.
 * Mirrors the backend `MASK_VIDEO_WHITE_THRESHOLD`.
 */
export const MASK_VIDEO_WHITE_THRESHOLD = 32;

/**
 * Bounds of mask-positive pixels in a single-channel row-major frame, or
 * null when empty. Pixels count when strictly above `threshold`.
 */
export function getMaskBoundsFromChannel(
  channel: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
): MaskBounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width;
    for (let x = 0; x < width; x += 1) {
      if (channel[rowStart + x] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;
  return [minX, minY, maxX + 1, maxY + 1];
}

/**
 * Bounds of mask-positive pixels in RGBA pixel data (e.g. canvas
 * ImageData), reading the red channel like the backend does.
 */
export function getMaskBoundsFromRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number = MASK_VIDEO_WHITE_THRESHOLD,
): MaskBounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (rgba[rowStart + x * 4] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;
  return [minX, minY, maxX + 1, maxY + 1];
}

/** Tightest box enclosing both inputs. */
export function unionBounds(
  a: MaskBounds | null,
  b: MaskBounds | null,
): MaskBounds | null {
  if (a === null) return b;
  if (b === null) return a;
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/**
 * Expand the box symmetrically from its centre so its aspect ratio matches
 * `targetAr` (width / height). Returns floating-point coordinates.
 */
export function forceAspectRatio(
  bbox: MaskBounds,
  targetAr: number,
): [number, number, number, number] {
  const [x1, y1, x2, y2] = bbox;
  const w = x2 - x1;
  const h = y2 - y1;
  if (h === 0 || w === 0) return [x1, y1, x2, y2];

  const currentAr = w / h;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;

  let newW: number;
  let newH: number;
  if (currentAr > targetAr) {
    // Too wide → grow height
    newW = w;
    newH = w / targetAr;
  } else {
    // Too tall → grow width
    newW = h * targetAr;
    newH = h;
  }

  return [cx - newW / 2, cy - newH / 2, cx + newW / 2, cy + newH / 2];
}

/** Round to nearest even integer (codec-friendly). */
function roundEven(value: number): number {
  return Math.floor(value / 2 + 0.5) * 2;
}

/**
 * Apply dilation, cap at container, shift to fit, return even-int coords.
 *
 * `bbox` must already be forced to `targetAr` (see {@link forceAspectRatio});
 * because the container shares that AR, a single-dimension cap suffices.
 * `dilation` is a fraction (0.1 = 10% padding per side).
 */
export function computeCropRegion(
  bbox: [number, number, number, number],
  dilation: number,
  containerW: number,
  containerH: number,
  targetAr: number,
): MaskBounds {
  void targetAr;
  const [x1, y1, x2, y2] = bbox;
  const w = x2 - x1;
  const h = y2 - y1;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;

  let newW = w * (1 + dilation);
  let newH = h * (1 + dilation);

  // Cap at container (AR matches, so capping one dimension suffices).
  if (newW > containerW || newH > containerH) {
    newW = containerW;
    newH = containerH;
  }

  // Re-derive corners from centre before measuring: the backend rounds
  // (fx2 - fx1), which can differ from newW by an ulp — parity requires
  // taking the identical floating-point path.
  const preFx1 = cx - newW / 2;
  const preFy1 = cy - newH / 2;
  const preFx2 = cx + newW / 2;
  const preFy2 = cy + newH / 2;

  // Ensure dimensions are even, minimum 2×2.
  const cropW = Math.max(2, Math.min(roundEven(preFx2 - preFx1), containerW));
  const cropH = Math.max(2, Math.min(roundEven(preFy2 - preFy1), containerH));

  // Re-derive from centre with even dimensions.
  let fx1 = cx - cropW / 2;
  let fy1 = cy - cropH / 2;

  // Shift to stay within container bounds.
  if (fx1 < 0) {
    fx1 = 0;
  } else if (fx1 + cropW > containerW) {
    fx1 = containerW - cropW;
  }

  if (fy1 < 0) {
    fy1 = 0;
  } else if (fy1 + cropH > containerH) {
    fy1 = containerH - cropH;
  }

  const ix1 = pythonRound(fx1);
  const iy1 = pythonRound(fy1);

  return [ix1, iy1, ix1 + cropW, iy1 + cropH];
}

/**
 * End-to-end: union bbox → force AR → dilate → crop region. Returns
 * even-integer dimensions, or null when the mask is empty everywhere or the
 * crop would cover the whole container (no benefit).
 */
export function computeMaskCrop(
  accumulatedBounds: MaskBounds | null,
  containerW: number,
  containerH: number,
  targetAr: number,
  dilation: number = 0.1,
): MaskBounds | null {
  if (accumulatedBounds === null) return null;

  const arBox = forceAspectRatio(accumulatedBounds, targetAr);
  const crop = computeCropRegion(arBox, dilation, containerW, containerH, targetAr);

  const [cx1, cy1, cx2, cy2] = crop;
  if (cx1 === 0 && cy1 === 0 && cx2 >= containerW && cy2 >= containerH) {
    return null;
  }

  return crop;
}
