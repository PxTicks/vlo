/**
 * Whole-frame video rescaling via mediabunny. The frontend substitute for the
 * backend aspect-ratio stage, which hijacks the workflow's resize nodes so
 * ComfyUI generates at strided dimensions
 * (`gen_pipeline/processors/aspect_ratio.py`). Because the frontend uploads
 * already-rendered media instead of mutating the graph, it must resize the
 * media itself before dispatch — the mask-crop stage runs first (at project
 * dimensions, matching the backend's `before_upload` crop), and only then is
 * the cropped content stretched to the model-friendly strided size.
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Output,
} from "mediabunny";
import { resolveVideoOutputContainer } from "../pipeline/utils/media";
import {
  extensionForMimeType,
  renameWithExtension,
} from "../pipeline/utils/files";

export interface ResizeVideoOptions {
  /** Target bitrate for the re-encode; omit for mediabunny's default. */
  bitrate?: number;
  signal?: AbortSignal;
}

function toEvenDimension(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid resize dimension: ${value}`);
  }
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Stretch a video file to exactly `width`×`height` (H.264-safe even dims) and
 * re-encode as MP4. Uses `fit: "fill"`, matching the aspect-ratio postprocess's
 * `stretch_exact` mode — the strided target already carries the intended aspect
 * ratio, so the distortion is the one the postprocess later reverses. Audio
 * tracks pass through untouched.
 */
export async function resizeVideoToDimensions(
  file: File,
  width: number,
  height: number,
  options: ResizeVideoOptions = {},
): Promise<File> {
  const targetWidth = toEvenDimension(width);
  const targetHeight = toEvenDimension(height);

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
        width: targetWidth,
        height: targetHeight,
        fit: "fill",
        ...(options.bitrate !== undefined ? { bitrate: options.bitrate } : {}),
        hardwareAcceleration: "prefer-hardware",
      },
    });
    if (options.signal) {
      const signal = options.signal;
      if (signal.aborted) {
        await conversion.cancel();
        throw new DOMException("Video resize aborted", "AbortError");
      }
      signal.addEventListener("abort", () => void conversion.cancel(), {
        once: true,
      });
    }
    await conversion.execute();
    if (options.signal?.aborted) {
      throw new DOMException("Video resize aborted", "AbortError");
    }
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
