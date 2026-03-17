/**
 * Canvas, bitmap, and visual media resize utilities for the generation pipeline.
 */

import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  BufferTarget,
} from "mediabunny";
import type { AspectRatioProcessingMetadata } from "../../types";
import { getOutputMediaKindFromFile } from "../../constants/mediaKinds";
import {
  fileExtension,
  extensionForMimeType,
  renameWithExtension,
} from "./files";
import { toPositiveInteger } from "./fps";

// ---------------------------------------------------------------------------
// Resize target resolution
// ---------------------------------------------------------------------------

export interface ResizeTarget {
  width: number;
  height: number;
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(Math.round(a));
  let right = Math.abs(Math.round(b));

  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }

  return left || 1;
}

function formatAspectRatio(width: number, height: number): string | null {
  const normalizedWidth = toPositiveInteger(width);
  const normalizedHeight = toPositiveInteger(height);
  if (normalizedWidth === null || normalizedHeight === null) return null;

  const divisor = greatestCommonDivisor(normalizedWidth, normalizedHeight);
  return `${normalizedWidth / divisor}:${normalizedHeight / divisor}`;
}

export function resolveResizeTarget(
  metadata: AspectRatioProcessingMetadata | null | undefined,
): ResizeTarget | null {
  if (!metadata || metadata.enabled !== true) return null;
  const postprocess = metadata.postprocess;
  if (!postprocess || postprocess.enabled !== true) return null;
  if (postprocess.mode !== "stretch_exact") return null;
  if (postprocess.apply_to !== "all_visual_outputs") return null;
  const width = toPositiveInteger(postprocess.target_width);
  const height = toPositiveInteger(postprocess.target_height);
  if (width === null || height === null) return null;
  return { width, height };
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

export function createOutputCanvas(
  width: number,
  height: number,
): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function isCanvas2DContext(
  value: OffscreenCanvasRenderingContext2D | RenderingContext | null,
): value is OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  return (
    value !== null &&
    typeof (value as { drawImage?: unknown }).drawImage === "function" &&
    typeof (value as { clearRect?: unknown }).clearRect === "function"
  );
}

export async function convertCanvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mimeType: string,
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    if (mimeType === "image/jpeg" || mimeType === "image/webp") {
      return canvas.convertToBlob({ type: mimeType, quality: 0.95 });
    }
    return canvas.convertToBlob({ type: mimeType });
  }
  return new Promise<Blob>((resolve, reject) => {
    const onBlob = (blob: Blob | null) => {
      if (!blob) {
        reject(new Error("Canvas conversion returned an empty blob"));
        return;
      }
      resolve(blob);
    };
    if (mimeType === "image/jpeg" || mimeType === "image/webp") {
      canvas.toBlob(onBlob, mimeType, 0.95);
      return;
    }
    canvas.toBlob(onBlob, mimeType);
  });
}

// ---------------------------------------------------------------------------
// MIME type resolution
// ---------------------------------------------------------------------------

export function resolveImageOutputMimeType(input: File): string {
  const type = input.type.toLowerCase();
  if (
    type === "image/png" ||
    type === "image/jpeg" ||
    type === "image/webp" ||
    type === "image/bmp"
  ) {
    return type;
  }
  return "image/png";
}

export function resolveVideoOutputContainer(
  input: File,
): {
  mimeType: "video/mp4" | "video/webm";
  format: Mp4OutputFormat | WebMOutputFormat;
} {
  if (fileExtension(input.name) === ".webm") {
    return {
      mimeType: "video/webm",
      format: new WebMOutputFormat(),
    };
  }
  return {
    mimeType: "video/mp4",
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
  };
}

// ---------------------------------------------------------------------------
// Input media probing
// ---------------------------------------------------------------------------

export async function probeVisualFileAspectRatio(
  file: File,
): Promise<string | null> {
  const mediaKind = getOutputMediaKindFromFile(file);
  if (mediaKind === "image") {
    const bitmap = await createImageBitmap(file);
    try {
      return formatAspectRatio(bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }

  if (mediaKind !== "video") {
    return null;
  }

  const probeBlob = file.slice(0, 1);
  if (typeof probeBlob.arrayBuffer !== "function") {
    return null;
  }

  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) return null;
    return formatAspectRatio(videoTrack.displayWidth, videoTrack.displayHeight);
  } finally {
    input.dispose();
  }
}

// ---------------------------------------------------------------------------
// Image / video resize
// ---------------------------------------------------------------------------

export async function resizeImageToExactDimensions(
  file: File,
  target: ResizeTarget,
): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = createOutputCanvas(target.width, target.height);
    const context2dRaw = canvas.getContext("2d");
    if (!isCanvas2DContext(context2dRaw)) {
      throw new Error("Failed to acquire 2D context for image resize");
    }
    context2dRaw.clearRect(0, 0, target.width, target.height);
    context2dRaw.drawImage(bitmap, 0, 0, target.width, target.height);

    const outputMimeType = resolveImageOutputMimeType(file);
    const outputBlob = await convertCanvasToBlob(canvas, outputMimeType);
    const outputName = renameWithExtension(
      file.name,
      extensionForMimeType(outputMimeType),
    );
    return new File([outputBlob], outputName, {
      type: outputMimeType,
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
}

export async function resizeVideoToExactDimensions(
  file: File,
  target: ResizeTarget,
): Promise<File> {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  try {
    const { mimeType, format } = resolveVideoOutputContainer(file);
    const outputTarget = new BufferTarget();
    const output = new Output({
      format,
      target: outputTarget,
    });
    const conversion = await Conversion.init({
      input,
      output,
      video: {
        width: target.width,
        height: target.height,
        fit: "fill",
      },
    });
    await conversion.execute();
    if (!outputTarget.buffer) {
      throw new Error("Video resize output buffer is empty");
    }
    const outputName = renameWithExtension(
      file.name,
      extensionForMimeType(mimeType),
    );
    return new File([outputTarget.buffer], outputName, {
      type: mimeType,
      lastModified: Date.now(),
    });
  } finally {
    input.dispose();
  }
}

export async function maybeResizeVisualFile(
  file: File,
  target: ResizeTarget | null,
): Promise<File> {
  if (!target) return file;
  const mediaKind = getOutputMediaKindFromFile(file);
  if (mediaKind === "image") {
    try {
      return await resizeImageToExactDimensions(file, target);
    } catch (error) {
      console.warn("[Generation] Failed to resize image output", error);
      return file;
    }
  }
  if (mediaKind === "video") {
    try {
      return await resizeVideoToExactDimensions(file, target);
    } catch (error) {
      console.warn("[Generation] Failed to resize video output", error);
      return file;
    }
  }
  return file;
}
