import xxhash from "xxhash-wasm";
import {
  Input,
  BlobSource,
  ALL_FORMATS,
  CanvasSink,
  Output,
  Mp4OutputFormat,
  BufferTarget,
  Conversion,
} from "mediabunny";
import { CLIP_HEIGHT } from "../../timeline";
import { sanitizeFilename } from "../utils/filenameSanitization";

export class MediaFileProcessor {
  private file: File;
  private input: Input | null = null;
  private isDisposed = false;

  constructor(file: File) {
    this.file = file;
  }

  /**
   * Lazy-loads the mediabunny Input.
   */
  private getInput(): Input {
    if (this.isDisposed) {
      throw new Error("MediaFileProcessor is disposed");
    }
    if (!this.input) {
      this.input = new Input({
        source: new BlobSource(this.file),
        formats: ALL_FORMATS,
      });
    }
    return this.input;
  }

  /**
   * Releases resources (Input).
   */
  dispose() {
    if (this.input) {
      this.input.dispose();
      this.input = null;
    }
    this.isDisposed = true;
  }

  /**
   * Attempts to detect MIME type from magic bytes.
   */
  async detectMimeType(): Promise<string> {
    if (this.isDisposed) throw new Error("MediaFileProcessor is disposed");
    try {
      const input = this.getInput();
      const mimeType = await input.getMimeType();
      return mimeType || this.file.type;
    } catch (e) {
      console.warn("Retreiving mime type via mediabunny failed:", e);
      return this.file.type;
    }
  }

  /**
   * Computes media duration in seconds for audio or video files.
   */
  async computeDuration(): Promise<number> {
    if (this.isDisposed) throw new Error("MediaFileProcessor is disposed");
    try {
      const input = this.getInput();
      const durationSec = await input.computeDuration();
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        return 0;
      }
      return durationSec;
    } catch (error) {
      console.warn("Failed to compute media duration", error);
      return 0;
    }
  }

  /**
   * Generates a thumbnail blob and duration for a video file.
   */
  async generateVideoMetadata(): Promise<{
    thumbnail: Blob | null;
    duration: number;
    fps: number | null;
  }> {
    if (this.isDisposed) throw new Error("MediaFileProcessor is disposed");
    try {
      const input = this.getInput();
      const THUMBNAIL_MAX_SIZE = 320;

      // 1. Get Duration
      const durationSec = await input.computeDuration();
      const duration = durationSec || 0;

      // 2. Extract Thumbnail
      let thumbnail: Blob | null = null;
      let fps: number | null = null;
      const videoTrack = await input.getPrimaryVideoTrack();

      if (videoTrack) {
        try {
          const stats = await videoTrack.computePacketStats(240);
          if (
            Number.isFinite(stats.averagePacketRate) &&
            stats.averagePacketRate > 0
          ) {
            fps = Number(stats.averagePacketRate.toFixed(3));
          }
        } catch (error) {
          console.warn("Failed to estimate video FPS", error);
        }

        const { displayWidth, displayHeight } = videoTrack;
        const sinkOptions: {
          width?: number;
          height?: number;
          poolSize: number;
        } = {
          poolSize: 1,
        };

        if (displayWidth >= displayHeight) {
          sinkOptions.width = THUMBNAIL_MAX_SIZE;
        } else {
          sinkOptions.height = THUMBNAIL_MAX_SIZE;
        }

        const sink = new CanvasSink(videoTrack, sinkOptions);

        let startTime = 0;
        try {
          startTime = await videoTrack.getFirstTimestamp();
        } catch {
          // ignore error
        }
        const targetTime = startTime + Math.min(1.0, duration / 2);
        const iterator = sink.canvases(targetTime);
        const frame = (await iterator.next()).value;

        if (frame && frame.canvas) {
          const canvas = frame.canvas;
          if (canvas instanceof OffscreenCanvas) {
            thumbnail = await canvas.convertToBlob({
              type: "image/webp",
              quality: 0.7,
            });
          } else {
            const blob = await new Promise<Blob | null>((resolve) =>
              canvas.toBlob(resolve, "image/webp", 0.7),
            );
            thumbnail = blob;
          }
        }

        await iterator.return();
        // Do NOT dispose input here, we own it
      }

      return { thumbnail, duration, fps };
    } catch (e) {
      console.error("Failed to generate metadata", e);
      return { thumbnail: null, duration: 0, fps: null };
    }
  }

  /**
   * Checks if the media file has an audio track.
   */
  async hasAudioTrack(): Promise<boolean> {
    if (this.isDisposed) throw new Error("MediaFileProcessor is disposed");
    try {
      const input = this.getInput();
      const audioTrack = await input.getPrimaryAudioTrack();
      return audioTrack !== null;
    } catch (e) {
      console.warn("Failed to check for audio track:", e);
      return false;
    }
  }

  /**
   * Generates a proxy video blob using mediabunny.
   */
  async generateProxyVideo(): Promise<Blob | null> {
    if (this.isDisposed) throw new Error("MediaFileProcessor is disposed");
    try {
      const input = this.getInput();

      // 1. Get track info
      const track = await input.getPrimaryVideoTrack();
      if (!track) {
        return null; // Don't dispose input
      }

      const targetHeight = CLIP_HEIGHT;

      // 2. Configure Output
      const output = new Output({
        format: new Mp4OutputFormat(),
        target: new BufferTarget(),
      });

      const conversion = await Conversion.init({
        input,
        output,
        video: {
          codec: "avc",
          height: targetHeight,
          keyFrameInterval: 1.0,
          bitrate: 500_000,
        },
      });
      await conversion.execute();

      // Do NOT dispose input

      const buffer = (output.target as BufferTarget).buffer;
      if (!buffer) {
        throw new Error("Output buffer is empty");
      }

      return new Blob([buffer], {
        type: "video/mp4",
      });
    } catch (e) {
      console.error("Failed to generate proxy video", e);
      return null;
    }
  }
}

export class MediaProcessingService {
  private hasher: Awaited<ReturnType<typeof xxhash>> | null = null;

  async init() {
    if (!this.hasher) {
      this.hasher = await xxhash();
    }
  }

  createProcessor(file: File): MediaFileProcessor {
    return new MediaFileProcessor(file);
  }

  /**
   * Computes XXHash64 checksum of a File.
   * (Stateless, efficient enough as is)
   */
  async computeChecksum(file: File): Promise<string> {
    await this.init();

    const stream = file.stream();
    const reader = stream.getReader();
    const h64 = this.hasher!.create64();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        h64.update(value);
      }
      return h64.digest().toString(16);
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Sanitizes a filename to be safe for file systems.
   */
  sanitizeFilename(name: string): string {
    return sanitizeFilename(name);
  }

  /**
   * Generates thumbnail for image (Resize).
   * Does NOT rely on MediaBunny Input/FFmpeg, uses native Canvas.
   */
  async generateImageThumbnail(file: File): Promise<Blob> {
    const bitmap = await createImageBitmap(file);
    const MAX_SIZE = 320;
    let width = bitmap.width;
    let height = bitmap.height;

    if (width > height) {
      if (width > MAX_SIZE) {
        height = Math.round(height * (MAX_SIZE / width));
        width = MAX_SIZE;
      }
    } else {
      if (height > MAX_SIZE) {
        width = Math.round(width * (MAX_SIZE / height));
        height = MAX_SIZE;
      }
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get canvas context");

    ctx.drawImage(bitmap, 0, 0, width, height);

    return await canvas.convertToBlob({ type: "image/webp", quality: 0.7 });
  }

  // --- Convenience Wrappers (One-off usage) ---

  async detectMimeType(file: File): Promise<string> {
    const processor = this.createProcessor(file);
    try {
      return await processor.detectMimeType();
    } finally {
      processor.dispose();
    }
  }

  async computeDuration(file: File): Promise<number> {
    const processor = this.createProcessor(file);
    try {
      return await processor.computeDuration();
    } finally {
      processor.dispose();
    }
  }

  async generateVideoMetadata(
    file: File,
  ): Promise<{ thumbnail: Blob | null; duration: number; fps: number | null }> {
    const processor = this.createProcessor(file);
    try {
      return await processor.generateVideoMetadata();
    } finally {
      processor.dispose();
    }
  }

  async generateProxyVideo(file: File): Promise<Blob | null> {
    const processor = this.createProcessor(file);
    try {
      return await processor.generateProxyVideo();
    } finally {
      processor.dispose();
    }
  }

  async hasAudioTrack(file: File): Promise<boolean> {
    const processor = this.createProcessor(file);
    try {
      return await processor.hasAudioTrack();
    } finally {
      processor.dispose();
    }
  }
}

export const mediaProcessingService = new MediaProcessingService();
