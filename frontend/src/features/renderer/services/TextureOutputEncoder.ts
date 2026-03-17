import { Container, Sprite, type Application, type Texture } from "pixi.js";
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  StreamTarget,
  type StreamTargetChunk,
} from "mediabunny";
import {
  applyOutputTransformStack,
  type OutputTransform,
} from "../utils/outputTransformStack";

export type OutputVideoFormat = "mp4" | "webm";

export interface OutputVideoDefinition {
  id: string;
  format?: OutputVideoFormat;
  includeAudio?: boolean;
  preserveAlpha?: boolean;
  bitrate?: number;
  audioBitrate?: number;
  transformStack?: OutputTransform[];
  fileHandle?: FileSystemFileHandle;
}

interface ManagedOutput {
  definition: OutputVideoDefinition;
  mimeType: "video/mp4" | "video/webm";
  output: Output;
  target: BufferTarget | StreamTarget;
  videoSource: CanvasSource;
  audioSource: AudioBufferSource | null;
  fileStream?: FileSystemWritableFileStream;
}

function resolveVideoSourceCodec(
  format: OutputVideoFormat,
): "avc" | "vp9" {
  return format === "webm" ? "vp9" : "avc";
}

function resolveAudioSourceCodec(
  format: OutputVideoFormat,
): "aac" | "opus" {
  return format === "webm" ? "opus" : "aac";
}

function resolveMimeType(
  format: OutputVideoFormat,
): "video/mp4" | "video/webm" {
  return format === "webm" ? "video/webm" : "video/mp4";
}

export class TextureOutputEncoder {
  private app: Application;
  private outputStage: Container;
  private outputSprite: Sprite;
  private outputs: ManagedOutput[] = [];
  private definitions: OutputVideoDefinition[];
  private frameRate: number;
  private started = false;
  private audioClosed = false;

  constructor(
    app: Application,
    frameRate: number,
    definitions: OutputVideoDefinition[],
  ) {
    this.app = app;
    if (definitions.length === 0) {
      throw new Error("TextureOutputEncoder requires at least one output");
    }

    this.outputStage = new Container();
    this.outputSprite = new Sprite();
    this.outputSprite.anchor.set(0);
    this.outputStage.addChild(this.outputSprite);

    this.frameRate = frameRate;
    this.definitions = definitions;
  }

  public async start(): Promise<void> {
    if (this.started) return;

    this.outputs = await Promise.all(
      this.definitions.map(async (definition) => {
        const format = definition.format ?? "mp4";
        const mimeType = resolveMimeType(format);
        
        let target: BufferTarget | StreamTarget;
        let fileStream: FileSystemWritableFileStream | undefined;

        if (definition.fileHandle) {
          fileStream = await definition.fileHandle.createWritable();
          target = new StreamTarget(
            new WritableStream({
              write: (chunk: StreamTargetChunk) =>
                fileStream?.write(chunk.data) ?? Promise.resolve(),
              close: () => fileStream?.close() ?? Promise.resolve(),
              abort: () => fileStream?.abort() ?? Promise.resolve(),
            }),
          );
        } else {
          target = new BufferTarget();
        }

        const output = new Output({
          format:
            format === "webm"
              ? new WebMOutputFormat()
              : new Mp4OutputFormat({ fastStart: definition.fileHandle ? "in-memory" : "in-memory" }),
          target,
        });

        const videoSource = new CanvasSource(this.app.canvas, {
          codec: resolveVideoSourceCodec(format),
          bitrate: definition.bitrate ?? 6_000_000,
          latencyMode: "quality",
          ...(format === "webm" && definition.preserveAlpha
            ? { alpha: "keep" as const }
            : {}),
        });
        output.addVideoTrack(videoSource, { frameRate: this.frameRate });

        let audioSource: AudioBufferSource | null = null;
        if (definition.includeAudio) {
          audioSource = new AudioBufferSource({
            codec: resolveAudioSourceCodec(format),
            bitrate: definition.audioBitrate ?? 128_000,
          });
          output.addAudioTrack(audioSource);
        }

        return {
          definition,
          mimeType,
          output,
          target,
          videoSource,
          audioSource,
          fileStream,
        };
      }),
    );

    for (const output of this.outputs) {
      await output.output.start();
    }
    this.started = true;
  }

  public async addAudioChunk(audioBuffer: AudioBuffer): Promise<void> {
    for (const output of this.outputs) {
      if (output.audioSource) {
        await output.audioSource.add(audioBuffer);
      }
    }
  }

  public async closeAudioTracks(): Promise<void> {
    if (this.audioClosed) return;
    for (const output of this.outputs) {
      if (output.audioSource) {
        await output.audioSource.close();
      }
    }
    this.audioClosed = true;
  }

  public async addTextureFrame(
    sourceTexture: Texture,
    timestamp: number,
    frameDuration: number,
  ): Promise<void> {
    for (const output of this.outputs) {
      applyOutputTransformStack(
        this.outputSprite,
        sourceTexture,
        output.definition.transformStack,
      );
      this.app.renderer.render({
        container: this.outputStage,
        clear: true,
      });
      await output.videoSource.add(timestamp, frameDuration);
    }
  }

  public async finalize(): Promise<Record<string, Blob>> {
    for (const output of this.outputs) {
      await output.videoSource.close();
      await output.output.finalize();
    }

    const blobs: Record<string, Blob> = {};
    for (const output of this.outputs) {
      if (!output.fileStream) {
        if (!("buffer" in output.target) || !output.target.buffer) {
          throw new Error(`Rendered output '${output.definition.id}' is empty`);
        }
        blobs[output.definition.id] = new Blob([output.target.buffer], {
          type: output.mimeType,
        });
      }
    }
    return blobs;
  }

  public dispose(): void {
    this.outputStage.destroy({ children: true });
  }
}
