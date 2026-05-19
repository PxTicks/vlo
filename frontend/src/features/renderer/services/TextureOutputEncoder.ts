import { Container, Sprite, type Application, type Texture } from "pixi.js";
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from "mediabunny";
import {
  applyOutputTransformStack,
  type OutputTransform,
} from "../utils/outputTransformStack";

export type OutputVideoFormat = "mp4";
export type OutputContentProbe = "non_black_pixels";

export interface OutputVideoAnalysis {
  hasVisibleContent: boolean;
}

export interface OutputVideoDefinition {
  id: string;
  format?: OutputVideoFormat;
  includeAudio?: boolean;
  bitrate?: number;
  audioBitrate?: number;
  transformStack?: OutputTransform[];
  fileHandle?: FileSystemFileHandle;
  /**
   * Optional analysis over the transformed output.
   * Used by derived-mask exports to detect effectively empty mattes.
   */
  contentProbe?: OutputContentProbe;
}

interface ManagedOutput {
  definition: OutputVideoDefinition;
  mimeType: "video/mp4";
  output: Output;
  target: BufferTarget | StreamTarget;
  videoSource: CanvasSource;
  audioSource: AudioBufferSource | null;
  fileStream?: FileSystemWritableFileStream;
  measuredContent: boolean;
  hasVisibleContent: boolean;
  canMeasureContent: boolean;
}

interface RendererExtractApi {
  pixels?: (target?: unknown) => Uint8Array | Uint8ClampedArray;
  canvas?: (target?: unknown) => HTMLCanvasElement | Promise<HTMLCanvasElement>;
}

interface RendererReadbackApi {
  gl?: WebGLRenderingContext | WebGL2RenderingContext;
  extract?: RendererExtractApi;
}

interface FinalizedOutputBundle {
  blobs: Record<string, Blob>;
  analyses: Record<string, OutputVideoAnalysis>;
}

function pixelsContainNonBlackContent(pixels: ArrayLike<number>): boolean {
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] > 0 || pixels[index + 1] > 0 || pixels[index + 2] > 0) {
      return true;
    }
  }
  return false;
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
        const mimeType = "video/mp4";

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
          format: new Mp4OutputFormat({ fastStart: "in-memory" }),
          target,
        });

        const videoSource = new CanvasSource(this.app.canvas, {
          codec: "avc",
          bitrate: definition.bitrate ?? 6_000_000,
          latencyMode: "quality",
          hardwareAcceleration: "prefer-hardware",
        });
        output.addVideoTrack(videoSource, { frameRate: this.frameRate });

        let audioSource: AudioBufferSource | null = null;
        if (definition.includeAudio) {
          audioSource = new AudioBufferSource({
            codec: "aac",
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
          measuredContent: false,
          hasVisibleContent: false,
          canMeasureContent: definition.contentProbe === "non_black_pixels",
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
      if (
        output.definition.contentProbe === "non_black_pixels" &&
        output.canMeasureContent &&
        !output.hasVisibleContent
      ) {
        const hasVisibleContent = await this.probeRenderedOutputContent();
        if (typeof hasVisibleContent === "boolean") {
          output.measuredContent = true;
          output.hasVisibleContent = hasVisibleContent;
        } else {
          output.canMeasureContent = false;
        }
      }
      await output.videoSource.add(timestamp, frameDuration);
    }
  }

  private async probeRenderedOutputContent(): Promise<boolean | null> {
    const renderer = this.app.renderer as unknown as RendererReadbackApi;
    const gl = renderer.gl;

    if (gl && typeof gl.readPixels === "function") {
      try {
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        if (width > 0 && height > 0) {
          const pixels = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          return pixelsContainNonBlackContent(pixels);
        }
      } catch {
        // Fall back to Pixi's extract helpers below.
      }
    }

    const extract = renderer.extract;

    if (extract?.pixels) {
      try {
        return pixelsContainNonBlackContent(extract.pixels(this.outputStage));
      } catch {
        // Fall through to the canvas-based path below.
      }
    }

    if (extract?.canvas) {
      try {
        const canvas = await Promise.resolve(extract.canvas(this.outputStage));
        const context = canvas.getContext("2d");
        if (!context) {
          return null;
        }
        const imageData = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        );
        return pixelsContainNonBlackContent(imageData.data);
      } catch {
        return null;
      }
    }

    return null;
  }

  public async finalize(): Promise<FinalizedOutputBundle> {
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

    const analyses: Record<string, OutputVideoAnalysis> = {};
    for (const output of this.outputs) {
      if (
        output.definition.contentProbe === "non_black_pixels" &&
        output.measuredContent
      ) {
        analyses[output.definition.id] = {
          hasVisibleContent: output.hasVisibleContent,
        };
      }
    }

    return {
      blobs,
      analyses,
    };
  }

  public dispose(): void {
    this.outputStage.destroy({ children: true });
  }
}
