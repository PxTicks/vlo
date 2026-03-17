import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Output,
  WavOutputFormat,
} from "mediabunny";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import { renderTimelineSelectionToWebm } from "./inputSelection";
import { throwIfAborted } from "../pipeline/utils/abort";

function toPositiveInt(
  value: number | null | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.round(value));
}

export async function extractAudioFromVideo(
  file: File,
  options: { signal?: AbortSignal } = {},
): Promise<File | null> {
  throwIfAborted(options.signal);
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });

  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    throwIfAborted(options.signal);
    if (!audioTrack) return null;

    const target = new BufferTarget();
    const output = new Output({
      format: new WavOutputFormat(),
      target,
    });

    const conversion = await Conversion.init({
      input,
      output,
      video: { discard: true },
    });
    await conversion.execute();
    throwIfAborted(options.signal);

    if (!target.buffer) return null;
    return new File([target.buffer], `generation-audio-${Date.now()}.wav`, {
      type: "audio/wav",
      lastModified: Date.now(),
    });
  } finally {
    input.dispose();
  }
}

export async function extractAudioFromSelection(
  selection: TimelineSelection,
  options: { exportFps?: number; signal?: AbortSignal } = {},
): Promise<File | null> {
  throwIfAborted(options.signal);
  // Current implementation renders the selection once and extracts audio from the result.
  // A future iteration can move this to a direct audio-only render path.
  const normalizedSelection: TimelineSelection = { ...selection };
  const exportFps = toPositiveInt(options.exportFps, -1);
  if (exportFps > 0) {
    if (
      typeof normalizedSelection.fps !== "number" ||
      !Number.isFinite(normalizedSelection.fps) ||
      normalizedSelection.fps <= 0
    ) {
      normalizedSelection.fps = exportFps;
    }
  }
  const renderedVideo = await renderTimelineSelectionToWebm(normalizedSelection, {
    signal: options.signal,
  });
  throwIfAborted(options.signal);
  return extractAudioFromVideo(renderedVideo, { signal: options.signal });
}
