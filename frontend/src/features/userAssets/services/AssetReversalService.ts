import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  Input,
  Mp3OutputFormat,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  type AudioCodec,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  WavOutputFormat,
} from "mediabunny";
import { sanitizeFilename } from "../utils/filenameSanitization";

/**
 * AssetReversalService — produces a time-reversed copy of an existing media
 * asset's underlying File. The output File can then be ingested as a brand
 * new Asset and hot-swapped onto a clip.
 *
 * Strategy:
 *   - Video: decode every sample into an OffscreenCanvas (CPU RAM), then
 *     encode the canvases back in reverse order with fresh monotonically-
 *     increasing timestamps. The reversed sample at output index i keeps the
 *     original sample's duration, so total track duration is preserved.
 *   - Audio: drain every AudioBuffer into a single contiguous Float32Array per
 *     channel, reverse the samples, then re-encode into a new container.
 *
 * Memory: this implementation holds the entire decoded media in memory. For
 * typical timeline clips (seconds to a minute) this is fine; very long files
 * would warrant a chunked re-encoding strategy.
 */

export interface ReversalProgress {
  stage: "decode-video" | "decode-audio" | "encode" | "finalize";
  /** Fraction of the current stage that is complete, 0..1. */
  fraction: number;
}

export interface ReverseAssetFileOptions {
  onProgress?: (progress: ReversalProgress) => void;
}

interface DecodedVideo {
  frames: { canvas: OffscreenCanvas; duration: number }[];
  codedWidth: number;
  codedHeight: number;
}

interface DecodedAudio {
  channels: Float32Array[];
  sampleRate: number;
  sourceCodec: string | null;
}

function buildReversedFilename(sourceName: string, extension: string): string {
  const sanitized = sanitizeFilename(sourceName);
  const baseName =
    sanitized.replace(/\.[a-z0-9]+$/i, "").trim() || "reversed";
  return `${baseName}-reversed.${extension}`;
}

function pickAudioContainer(sourceCodec: string | null): {
  format: "mp4" | "mp3" | "wav";
  mimeType: string;
  extension: string;
  encodingCodec: AudioCodec;
} {
  switch (sourceCodec) {
    case "mp3":
      return {
        format: "mp3",
        mimeType: "audio/mpeg",
        extension: "mp3",
        encodingCodec: "mp3",
      };
    case "pcm-s16":
    case "pcm-s24":
    case "pcm-s32":
    case "pcm-f32":
    case "pcm-u8":
    case "ulaw":
    case "alaw":
      return {
        format: "wav",
        mimeType: "audio/wav",
        extension: "wav",
        encodingCodec: "pcm-s16",
      };
    case "aac":
    case "ac3":
    case "eac3":
    default:
      // Sensible default for high-compatibility playback.
      return {
        format: "mp4",
        mimeType: "audio/mp4",
        extension: "m4a",
        encodingCodec: "aac",
      };
  }
}

function createOutputFormat(format: "mp4" | "mp3" | "wav") {
  switch (format) {
    case "mp4":
      return new Mp4OutputFormat();
    case "mp3":
      return new Mp3OutputFormat();
    case "wav":
      return new WavOutputFormat();
  }
}

async function decodeVideoFrames(
  input: Input,
  onProgress?: (fraction: number) => void,
): Promise<DecodedVideo | null> {
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) return null;

  const codedWidth = videoTrack.codedWidth;
  const codedHeight = videoTrack.codedHeight;
  if (codedWidth === 0 || codedHeight === 0) return null;

  const totalDuration = await videoTrack.computeDuration();
  const sink = new VideoSampleSink(videoTrack);
  const frames: DecodedVideo["frames"] = [];

  let cursor = 0;
  for await (const sample of sink.samples()) {
    const canvas = new OffscreenCanvas(codedWidth, codedHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      sample.close();
      continue;
    }
    sample.draw(ctx, 0, 0, codedWidth, codedHeight);
    frames.push({ canvas, duration: sample.duration });
    cursor = sample.timestamp + sample.duration;
    sample.close();

    if (totalDuration > 0 && onProgress) {
      onProgress(Math.min(1, cursor / totalDuration));
    }
  }

  if (frames.length === 0) return null;
  return { frames, codedWidth, codedHeight };
}

async function decodeAudioChannels(
  input: Input,
  onProgress?: (fraction: number) => void,
): Promise<DecodedAudio | null> {
  const audioTrack = await input.getPrimaryAudioTrack();
  if (!audioTrack) return null;

  const totalDuration = await audioTrack.computeDuration();
  const sink = new AudioBufferSink(audioTrack);

  const collected: AudioBuffer[] = [];
  let sampleRate = 0;
  let numberOfChannels = 0;
  let totalFrames = 0;

  for await (const wrapped of sink.buffers()) {
    const buffer = wrapped.buffer;
    if (buffer.length === 0) continue;
    sampleRate = buffer.sampleRate;
    numberOfChannels = Math.max(numberOfChannels, buffer.numberOfChannels);
    totalFrames += buffer.length;
    collected.push(buffer);

    if (totalDuration > 0 && onProgress) {
      onProgress(
        Math.min(1, (wrapped.timestamp + wrapped.duration) / totalDuration),
      );
    }
  }

  if (totalFrames === 0 || sampleRate === 0 || numberOfChannels === 0) {
    return null;
  }

  const channels: Float32Array[] = Array.from(
    { length: numberOfChannels },
    () => new Float32Array(totalFrames),
  );

  let writeOffset = 0;
  for (const chunk of collected) {
    const chunkLen = chunk.length;
    for (let ch = 0; ch < numberOfChannels; ch++) {
      if (ch < chunk.numberOfChannels) {
        // Decode into a freshly-owned Float32Array, then splice into the
        // contiguous per-channel buffer. We avoid handing copyFromChannel a
        // subarray of our pre-allocated array because lib.dom typings narrow
        // copyFromChannel's destination to Float32Array<ArrayBuffer>, while
        // subarray() widens to ArrayBufferLike.
        const decoded = new Float32Array(chunkLen);
        chunk.copyFromChannel(decoded, ch);
        channels[ch].set(decoded, writeOffset);
      }
      // Channels beyond the source count remain zeroed.
    }
    writeOffset += chunkLen;
  }

  // Reverse samples in-place per channel.
  for (const ch of channels) {
    let lo = 0;
    let hi = ch.length - 1;
    while (lo < hi) {
      const tmp = ch[lo];
      ch[lo] = ch[hi];
      ch[hi] = tmp;
      lo++;
      hi--;
    }
  }

  return {
    channels,
    sampleRate,
    sourceCodec: audioTrack.codec ?? null,
  };
}

async function encodeReversedVideo(
  videoSource: VideoSampleSource,
  decoded: DecodedVideo,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  // Reverse temporally; durations follow each frame so the total stream
  // length is preserved.
  const reversed = [...decoded.frames].reverse();
  const totalDuration = reversed.reduce((sum, f) => sum + f.duration, 0);
  let runningTimestamp = 0;
  for (let i = 0; i < reversed.length; i++) {
    const { canvas, duration } = reversed[i];
    const sample = new VideoSample(canvas, {
      timestamp: runningTimestamp,
      duration,
    });
    await videoSource.add(sample, { keyFrame: i === 0 });
    sample.close();
    runningTimestamp += duration;

    if (onProgress) {
      const denom = totalDuration > 0 ? totalDuration : reversed.length;
      onProgress(Math.min(1, runningTimestamp / denom));
    }
  }
  videoSource.close();
}

async function encodeReversedAudio(
  audioSource: AudioBufferSource,
  decoded: DecodedAudio,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const { channels, sampleRate } = decoded;
  const totalFrames = channels[0].length;
  const numberOfChannels = channels.length;

  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("OfflineAudioContext unavailable in this environment");
  }
  const audioCtx = new OfflineAudioContext(
    numberOfChannels,
    Math.max(1, totalFrames),
    sampleRate,
  );

  const CHUNK_FRAMES = Math.max(1, Math.min(totalFrames, sampleRate));
  let written = 0;
  while (written < totalFrames) {
    const frames = Math.min(CHUNK_FRAMES, totalFrames - written);
    const buffer = audioCtx.createBuffer(numberOfChannels, frames, sampleRate);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      // Copy via a fresh non-shared Float32Array to satisfy
      // copyToChannel's Float32Array<ArrayBuffer> destination typing.
      const slice = new Float32Array(frames);
      slice.set(channels[ch].subarray(written, written + frames));
      buffer.copyToChannel(slice, ch);
    }
    await audioSource.add(buffer);
    written += frames;
    onProgress?.(written / totalFrames);
  }
  audioSource.close();
}

export interface AssetReversalResult {
  file: File;
  hadVideo: boolean;
  hadAudio: boolean;
}

/**
 * Reverse a media file. Returns a new File whose payload plays in reverse.
 *
 * Constraints:
 *  - Still images cannot be reversed; the caller should guard against this.
 *  - The whole asset must fit in memory (decoded canvases + per-channel PCM).
 */
export async function reverseAssetFile(
  sourceFile: File,
  options: ReverseAssetFileOptions = {},
): Promise<AssetReversalResult> {
  const input = new Input({
    source: new BlobSource(sourceFile),
    formats: ALL_FORMATS,
  });

  try {
    // 1. Probe + decode all streams concurrently into RAM.
    const [decodedVideo, decodedAudio] = await Promise.all([
      decodeVideoFrames(input, (f) =>
        options.onProgress?.({ stage: "decode-video", fraction: f }),
      ),
      decodeAudioChannels(input, (f) =>
        options.onProgress?.({ stage: "decode-audio", fraction: f }),
      ),
    ]);

    if (!decodedVideo && !decodedAudio) {
      throw new Error("Source media has no usable video or audio track.");
    }

    // 2. Choose container.
    const isAudioOnly = !decodedVideo;
    const audioContainer = pickAudioContainer(decodedAudio?.sourceCodec ?? null);
    const containerFormat = isAudioOnly ? audioContainer.format : "mp4";
    const containerMime = isAudioOnly ? audioContainer.mimeType : "video/mp4";
    const containerExt = isAudioOnly ? audioContainer.extension : "mp4";

    const output = new Output({
      format: createOutputFormat(containerFormat),
      target: new BufferTarget(),
    });

    let videoSource: VideoSampleSource | null = null;
    let audioSource: AudioBufferSource | null = null;

    if (decodedVideo) {
      videoSource = new VideoSampleSource({
        codec: "avc",
        bitrate: QUALITY_HIGH,
      });
      output.addVideoTrack(videoSource);
    }
    if (decodedAudio) {
      audioSource = new AudioBufferSource({
        codec: audioContainer.encodingCodec,
        bitrate: QUALITY_HIGH,
      });
      output.addAudioTrack(audioSource);
    }

    // 3. Start output, then encode all reversed samples sequentially.
    await output.start();

    let encodeVideoFrac = 0;
    let encodeAudioFrac = 0;
    const totalWeight =
      (decodedVideo ? 1 : 0) + (decodedAudio ? 1 : 0);

    const notifyEncoding = () => {
      const fraction =
        totalWeight === 0
          ? 1
          : (encodeVideoFrac + encodeAudioFrac) / totalWeight;
      options.onProgress?.({ stage: "encode", fraction });
    };

    if (videoSource && decodedVideo) {
      await encodeReversedVideo(videoSource, decodedVideo, (f) => {
        encodeVideoFrac = f;
        notifyEncoding();
      });
    }
    if (audioSource && decodedAudio) {
      await encodeReversedAudio(audioSource, decodedAudio, (f) => {
        encodeAudioFrac = f;
        notifyEncoding();
      });
    }

    // 4. Finalize.
    options.onProgress?.({ stage: "finalize", fraction: 0 });
    await output.finalize();
    options.onProgress?.({ stage: "finalize", fraction: 1 });

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) {
      throw new Error("Reversal completed without an output buffer.");
    }

    const outName = buildReversedFilename(sourceFile.name, containerExt);
    const outMime =
      typeof output.getMimeType === "function"
        ? await output.getMimeType()
        : containerMime;

    return {
      file: new File([buffer], outName, {
        type: outMime || containerMime,
        lastModified: Date.now(),
      }),
      hadVideo: !!decodedVideo,
      hadAudio: !!decodedAudio,
    };
  } finally {
    input.dispose();
  }
}
