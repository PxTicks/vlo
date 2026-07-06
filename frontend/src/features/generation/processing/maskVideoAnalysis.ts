/**
 * Mask-video bounds analysis: decode a rendered mask MP4 and compute the
 * union crop region across all frames. Frontend counterpart of the backend
 * `analyze_mask_video_bounds` (`utils/video_crop.py`), sharing its
 * red-channel threshold semantics via {@link MASK_VIDEO_WHITE_THRESHOLD}.
 */

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import {
  MASK_VIDEO_WHITE_THRESHOLD,
  computeMaskCrop,
  getMaskBoundsFromRgba,
  unionBounds,
  type MaskBounds,
} from "./maskCropMath";
import { isCanvas2DContext } from "../pipeline/utils/media";

export interface VideoDimensions {
  width: number;
  height: number;
}

/** Width/height of the primary video track, or null when there is none. */
export async function probeVideoDimensions(
  file: File,
): Promise<VideoDimensions | null> {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) return null;
    return {
      width: videoTrack.displayWidth,
      height: videoTrack.displayHeight,
    };
  } finally {
    input.dispose();
  }
}

export interface AnalyzeMaskVideoBoundsOptions {
  /** Width / height. The crop region is expanded to this ratio. */
  targetAr: number;
  /** Fractional padding per side (0.1 = 10%). */
  dilation?: number;
  threshold?: number;
  signal?: AbortSignal;
}

export interface MaskVideoBoundsAnalysis {
  /** Union of per-frame content bounds before AR forcing/dilation; null when the mask is empty. */
  rawBounds: MaskBounds | null;
  /** Even-integer `(x1, y1, x2, y2)`, or null when the mask is empty or the crop covers the container. */
  cropRegion: MaskBounds | null;
  containerWidth: number;
  containerHeight: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Mask analysis aborted", "AbortError");
  }
}

/**
 * Decode every frame of a mask MP4, accumulate red-channel bounds, and
 * derive the crop region (union bounds → force AR → dilate → clamp).
 */
export async function analyzeMaskVideoBounds(
  maskFile: File,
  options: AnalyzeMaskVideoBoundsOptions,
): Promise<MaskVideoBoundsAnalysis> {
  const threshold = options.threshold ?? MASK_VIDEO_WHITE_THRESHOLD;
  const input = new Input({
    source: new BlobSource(maskFile),
    formats: ALL_FORMATS,
  });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error("Mask video has no video track");
    }
    const containerWidth = videoTrack.displayWidth;
    const containerHeight = videoTrack.displayHeight;

    // poolSize 1 reuses a single canvas; each frame is fully consumed via
    // getImageData before the next is decoded.
    const sink = new CanvasSink(videoTrack, { poolSize: 1 });

    let accumulated: MaskBounds | null = null;
    for await (const wrapped of sink.canvases()) {
      throwIfAborted(options.signal);
      const context = wrapped.canvas.getContext("2d", {
        willReadFrequently: true,
      });
      if (!isCanvas2DContext(context)) {
        throw new Error("Failed to acquire 2D context for mask analysis");
      }
      const imageData = context.getImageData(
        0,
        0,
        containerWidth,
        containerHeight,
      );
      accumulated = unionBounds(
        accumulated,
        getMaskBoundsFromRgba(
          imageData.data,
          containerWidth,
          containerHeight,
          threshold,
        ),
      );
    }

    return {
      rawBounds: accumulated,
      cropRegion: computeMaskCrop(
        accumulated,
        containerWidth,
        containerHeight,
        options.targetAr,
        options.dilation ?? 0.1,
      ),
      containerWidth,
      containerHeight,
    };
  } finally {
    input.dispose();
  }
}
