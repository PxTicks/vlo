/**
 * Rectangular video cropping via mediabunny. Frontend counterpart of the
 * backend `crop_video` (`utils/video_crop.py`): crops every frame to the
 * region and re-encodes, carrying audio through.
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Output,
} from "mediabunny";
import type { MaskBounds } from "./maskCropMath";
import { resolveVideoOutputContainer } from "../pipeline/utils/media";
import {
  extensionForMimeType,
  renameWithExtension,
} from "../pipeline/utils/files";

/**
 * Matches the dedicated mask-render bitrate used by the selection export
 * path — masks are read by ComfyUI's raw red channel, so favour fidelity.
 */
export const MASK_CROP_VIDEO_BITRATE = 20_000_000;

export interface CropVideoToRectOptions {
  /** Target bitrate for the re-encode; omit for mediabunny's default. */
  bitrate?: number;
  signal?: AbortSignal;
}

/**
 * Crop a video file to the `(x1, y1, x2, y2)` region (x2/y2 exclusive) and
 * re-encode as MP4. Audio tracks pass through the conversion untouched.
 */
export async function cropVideoToRect(
  file: File,
  region: MaskBounds,
  options: CropVideoToRectOptions = {},
): Promise<File> {
  const [x1, y1, x2, y2] = region;
  const cropWidth = x2 - x1;
  const cropHeight = y2 - y1;
  if (cropWidth <= 0 || cropHeight <= 0) {
    throw new Error(
      `Invalid crop dimensions: ${cropWidth}x${cropHeight} from region [${region.join(", ")}]`,
    );
  }

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
        crop: {
          left: x1,
          top: y1,
          width: cropWidth,
          height: cropHeight,
        },
        ...(options.bitrate !== undefined ? { bitrate: options.bitrate } : {}),
        hardwareAcceleration: "prefer-hardware",
      },
    });
    if (options.signal) {
      const signal = options.signal;
      if (signal.aborted) {
        await conversion.cancel();
        throw new DOMException("Video crop aborted", "AbortError");
      }
      signal.addEventListener("abort", () => void conversion.cancel(), {
        once: true,
      });
    }
    await conversion.execute();
    if (options.signal?.aborted) {
      throw new DOMException("Video crop aborted", "AbortError");
    }
    if (!outputTarget.buffer) {
      throw new Error("Video crop output buffer is empty");
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
