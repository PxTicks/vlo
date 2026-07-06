/**
 * Mask-crop processing orchestrator. Frontend counterpart of the backend
 * `_MaskCropProcessor` (`gen_pipeline/processors/mask_crop.py`): analyses
 * rendered mask videos for content bounds and crops the source video plus
 * visual masks to those bounds, emitting the same `mask_crop_metadata`
 * shape the delivery/replay pipeline already consumes.
 *
 * Deliberate differences from the backend:
 * - Multiple visual masks are analysed as a **union** and cropped with one
 *   shared region (the backend crops each pair to its own region, which can
 *   misalign a source from its second mask).
 * - Processing is all-or-nothing: any analysis/encode failure reverts to
 *   `{mode: "full"}` with the original files, so metadata never claims a
 *   crop that wasn't applied to every file.
 * - Audio-timing masks always pass through untouched: they are reduced to
 *   per-frame activity downstream, and cropping could erase small active
 *   regions (the backend equally excludes them — `collect_mask_crop_pairs`
 *   only pairs `purpose == "video"` targets).
 */

import type { MaskCropMetadata } from "../types";
import type { DerivedMaskRenderKey } from "../utils/inputSelection";
import type { ProcessingWarning } from "./aspectRatioProcessing";
import { parseAspectRatioParts } from "./aspectRatioProcessing";
import { computeMaskCrop, unionBounds, type MaskBounds } from "./maskCropMath";
import {
  analyzeMaskVideoBounds as defaultAnalyzeMaskVideoBounds,
  type AnalyzeMaskVideoBoundsOptions,
  type MaskVideoBoundsAnalysis,
} from "./maskVideoAnalysis";
import {
  MASK_CROP_VIDEO_BITRATE,
  cropVideoToRect as defaultCropVideoToRect,
  type CropVideoToRectOptions,
} from "./videoRectCrop";

export type MaskCropMode = "crop" | "full";

export function isAudioTimingMaskRenderKey(key: string): boolean {
  return key.startsWith("audio_timing_binary_");
}

export interface MaskCropProcessingInput {
  /** Rendered source selection video. */
  video: File;
  /** Rendered masks by render key; audio-timing keys pass through untouched. */
  masks: Partial<Record<DerivedMaskRenderKey, File>>;
  /** "<w>:<h>"; cropping is skipped without a parseable target. */
  targetAspectRatio: string | null | undefined;
  cropMode?: MaskCropMode;
  /** Fractional padding per side (0.1 = 10%); negative or missing skips cropping. */
  cropDilation?: number;
  signal?: AbortSignal;
}

export interface MaskCropProcessingResult {
  video: File;
  masks: Partial<Record<DerivedMaskRenderKey, File>>;
  metadata: MaskCropMetadata;
  warnings: ProcessingWarning[];
}

export interface MaskCropProcessingDeps {
  analyzeMaskVideoBounds: (
    maskFile: File,
    options: AnalyzeMaskVideoBoundsOptions,
  ) => Promise<MaskVideoBoundsAnalysis>;
  cropVideoToRect: (
    file: File,
    region: MaskBounds,
    options?: CropVideoToRectOptions,
  ) => Promise<File>;
}

const DEFAULT_DEPS: MaskCropProcessingDeps = {
  analyzeMaskVideoBounds: defaultAnalyzeMaskVideoBounds,
  cropVideoToRect: defaultCropVideoToRect,
};

function fullResult(
  input: MaskCropProcessingInput,
  warnings: ProcessingWarning[],
): MaskCropProcessingResult {
  return {
    video: input.video,
    masks: { ...input.masks },
    metadata: { mode: "full" },
    warnings,
  };
}

function buildCroppedMetadata(
  region: MaskBounds,
  containerWidth: number,
  containerHeight: number,
): MaskCropMetadata {
  const [x1, y1, x2, y2] = region;
  const cropWidth = x2 - x1;
  const cropHeight = y2 - y1;
  const originalDiagonal = Math.hypot(containerWidth, containerHeight);
  const croppedDiagonal = Math.hypot(cropWidth, cropHeight);
  const scale = originalDiagonal > 0 ? croppedDiagonal / originalDiagonal : 1;
  return {
    mode: "cropped",
    crop_position: [x1, y1],
    crop_size: [cropWidth, cropHeight],
    container_size: [containerWidth, containerHeight],
    scale: Math.round(scale * 1e6) / 1e6,
  };
}

/**
 * Crop the source video and visual masks to the masks' content bounds.
 * Returns the original files with `{mode: "full"}` metadata whenever
 * cropping is disabled, impossible, or fails.
 */
export async function applyMaskCropProcessing(
  input: MaskCropProcessingInput,
  deps: MaskCropProcessingDeps = DEFAULT_DEPS,
): Promise<MaskCropProcessingResult> {
  const warnings: ProcessingWarning[] = [];

  const visualMaskEntries = Object.entries(input.masks).filter(
    (entry): entry is [DerivedMaskRenderKey, File] =>
      entry[1] !== undefined && !isAudioTimingMaskRenderKey(entry[0]),
  );

  const dilation = input.cropDilation;
  const shouldCrop =
    input.cropMode !== "full" &&
    typeof dilation === "number" &&
    Number.isFinite(dilation) &&
    dilation >= 0 &&
    visualMaskEntries.length > 0;
  if (!shouldCrop) {
    return fullResult(input, warnings);
  }

  const parsedAr = parseAspectRatioParts(input.targetAspectRatio);
  if (!parsedAr) {
    return fullResult(input, warnings);
  }
  const targetAr = parsedAr[0] / parsedAr[1];

  try {
    // 1. Accumulate raw content bounds across every visual mask so all
    //    files are cropped with one consistent region.
    let accumulated: MaskBounds | null = null;
    let containerWidth: number | null = null;
    let containerHeight: number | null = null;
    for (const [key, maskFile] of visualMaskEntries) {
      const analysis = await deps.analyzeMaskVideoBounds(maskFile, {
        targetAr,
        dilation,
        signal: input.signal,
      });
      if (containerWidth === null || containerHeight === null) {
        containerWidth = analysis.containerWidth;
        containerHeight = analysis.containerHeight;
      } else if (
        containerWidth !== analysis.containerWidth ||
        containerHeight !== analysis.containerHeight
      ) {
        warnings.push({
          code: "mask_crop_container_mismatch",
          message: `Visual masks disagree on container dimensions; skipping crop (${key}: ${analysis.containerWidth}x${analysis.containerHeight}, expected ${containerWidth}x${containerHeight})`,
        });
        return fullResult(input, warnings);
      }
      accumulated = unionBounds(accumulated, analysis.rawBounds);
    }
    if (containerWidth === null || containerHeight === null) {
      return fullResult(input, warnings);
    }

    // 2. Union bounds → force AR → dilate → clamp; null means empty mask
    //    or a crop that would cover the whole container.
    const region = computeMaskCrop(
      accumulated,
      containerWidth,
      containerHeight,
      targetAr,
      dilation,
    );
    if (region === null) {
      return fullResult(input, warnings);
    }

    // 3. Crop everything with the shared region. Masks are read by
    //    ComfyUI's raw red channel, so favour fidelity on the re-encode.
    const masks: Partial<Record<DerivedMaskRenderKey, File>> = {
      ...input.masks,
    };
    for (const [key, maskFile] of visualMaskEntries) {
      masks[key] = await deps.cropVideoToRect(maskFile, region, {
        bitrate: MASK_CROP_VIDEO_BITRATE,
        signal: input.signal,
      });
    }
    const video = await deps.cropVideoToRect(input.video, region, {
      signal: input.signal,
    });

    return {
      video,
      masks,
      metadata: buildCroppedMetadata(region, containerWidth, containerHeight),
      warnings,
    };
  } catch (error) {
    if (input.signal?.aborted) {
      throw error;
    }
    warnings.push({
      code: "mask_crop_processing_failed",
      message: `Mask crop processing failed; continuing uncropped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return fullResult(input, warnings);
  }
}
