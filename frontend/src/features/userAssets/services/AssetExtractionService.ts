import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import {
  captureVideoFrameFile,
  type ResolvedEditorSource,
} from "../../miniEditor";
import { tickToMediaSeconds } from "../../renderer/utils/mediaTime";
import { sanitizeFilename } from "../utils/filenameSanitization";
import { resolveAudioExtractionPlan } from "./audioExtractionPlan";

function filenameStem(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, "").trim() || "asset";
}

export async function extractAssetRangeFile(
  source: ResolvedEditorSource,
  startTicks: number,
  endTicks: number,
): Promise<File> {
  const mediaType = source.mediaType ?? "video";
  if (mediaType !== "video" && mediaType !== "audio") {
    throw new Error("Only video and audio assets have extractable ranges.");
  }

  const start = tickToMediaSeconds(startTicks);
  const end = tickToMediaSeconds(endTicks);
  if (end <= start) {
    throw new Error("Select a non-empty range to extract.");
  }

  const input = new Input({
    source: new BlobSource(source.sourceFile),
    formats: ALL_FORMATS,
  });

  try {
    const isVideo = mediaType === "video";
    const audioTrack = isVideo ? null : await input.getPrimaryAudioTrack();
    if (!isVideo && !audioTrack) {
      throw new Error("The asset does not contain an audio track.");
    }
    const audioPlan = audioTrack
      ? resolveAudioExtractionPlan(audioTrack.codec)
      : null;
    const output = new Output({
      format: isVideo
        ? new Mp4OutputFormat({ fastStart: "in-memory" })
        : audioPlan!.outputSpec.createFormat(),
      target: new BufferTarget(),
    });
    const conversion = await Conversion.init({
      input,
      output,
      trim: { start, end },
      ...(isVideo
        ? {}
        : {
            video: { discard: true as const },
            audio: (track) =>
              track.id === audioTrack!.id
                ? { codec: audioPlan!.targetCodec }
                : { discard: true as const },
          }),
      showWarnings: false,
    });
    if (!conversion.isValid) {
      throw new Error("The selected range cannot be converted in this browser.");
    }
    await conversion.execute();

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) {
      throw new Error("Range extraction produced no media.");
    }

    const extension = isVideo ? "mp4" : audioPlan!.outputSpec.extension;
    const mimeType = isVideo ? "video/mp4" : audioPlan!.outputSpec.mimeType;
    return new File(
      [buffer],
      sanitizeFilename(
        `${filenameStem(source.sourceFile.name)}-excerpt.${extension}`,
      ),
      { type: mimeType, lastModified: Date.now() },
    );
  } finally {
    input.dispose();
  }
}

export async function extractAssetFrameFile(
  source: ResolvedEditorSource,
  playheadTicks: number,
): Promise<File> {
  if ((source.mediaType ?? "video") !== "video") {
    throw new Error("Frames can only be extracted from video assets.");
  }

  return captureVideoFrameFile(
    source.sourceUrl,
    tickToMediaSeconds(playheadTicks),
    sanitizeFilename(`${filenameStem(source.sourceFile.name)}-frame.png`),
  );
}
