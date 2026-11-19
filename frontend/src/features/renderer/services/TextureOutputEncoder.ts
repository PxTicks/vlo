import {
  Container,
  Sprite,
  type Application,
  type GetPixelsOutput,
  type Texture,
} from "pixi.js";
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
} from "mediabunny";
import {
  applyOutputTransformStack,
  type OutputTransform,
} from "../utils/outputTransformStack";
import type { ExportPhase } from "../../../core/export/exportProgress";
import { ExportFileTarget } from "./ExportFileTarget";
import { ensureAacEncoder } from "./aacEncoderFallback";
import type { ExportDiagnostic } from "./exportDiagnostics";

export type OutputVideoFormat = "mp4" | "webm";
export type OutputContentProbe = "non_black_pixels";

/**
 * Codec settings for one output. Shared with the detached host's readiness
 * probe, so it checks the configuration that will actually be encoded.
 */
export function outputEncodingSettings(
  format: OutputVideoFormat,
  rates: { bitrate?: number; audioBitrate?: number } = {},
) {
  const isAlphaWebM = format === "webm";
  return {
    video: {
      codec: isAlphaWebM ? ("vp9" as const) : ("avc" as const),
      bitrate: rates.bitrate ?? 6_000_000,
      ...(isAlphaWebM ? { alpha: "keep" as const } : {}),
      latencyMode: "quality" as const,
      // `no-preference`, not `prefer-hardware`. WebCodecs treats this as a
      // hint, but mediabunny fails closed on `isConfigSupported`, so
      // `prefer-hardware` turns "no hardware encoder for this codec" into a
      // hard export failure even when the software encoder would work.
      // Hardware VP9 *encode* is far less common than decode, so the WebM
      // composite-bake path broke on such machines while the H.264 path
      // kept working and masked it. Measured on a SwiftShader Chromium:
      // vp09.00.40.08 1920x1080 reports unsupported with `prefer-hardware`
      // and supported with `no-preference`. Browsers still prefer hardware
      // when it is available.
      hardwareAcceleration: "no-preference" as const,
    },
    audio: {
      codec: isAlphaWebM ? ("opus" as const) : ("aac" as const),
      bitrate: rates.audioBitrate ?? 128_000,
    },
  };
}

export interface OutputVideoAnalysis {
  hasVisibleContent: boolean;
}

export interface OutputVideoDefinition {
  id: string;
  format?: OutputVideoFormat;
  includeAudio?: boolean;
  bitrate?: number;
  /** Seconds between keyframes. Mediabunny defaults to 5 seconds. */
  keyFrameInterval?: number;
  audioBitrate?: number;
  transformStack?: OutputTransform[];
  fileHandle?: FileSystemFileHandle;
  /** Caller-owned stream; successful completion never materializes a Blob. */
  outputTarget?: ExportFileTarget;
  /**
   * Optional analysis over the transformed output.
   * Used by derived-mask exports to detect effectively empty mattes.
   */
  contentProbe?: OutputContentProbe;
}

/**
 * One output's frames submitted and packets received, for the unencoded-frame
 * bound. Waiters belong to the output too: a packet from another output says
 * nothing about this one's encoder.
 */
interface EncodeCounts {
  submitted: number;
  encoded: number;
  limit: number;
  packetWaiters: Array<() => void>;
}

interface ManagedOutput {
  definition: OutputVideoDefinition;
  mimeType: "video/mp4" | "video/webm";
  output: Output;
  target: BufferTarget | StreamTarget;
  videoSource: CanvasSource;
  audioSource: AudioBufferSource | null;
  fileTarget?: ExportFileTarget;
  submissionTimes?: Map<number, number>;
  /** Frames submitted and packets received, for the unencoded-frame bound. */
  encodeCounts: EncodeCounts;
  measuredContent: boolean;
  hasVisibleContent: boolean;
  canMeasureContent: boolean;
}

interface RendererExtractApi {
  pixels?: (target?: unknown) => GetPixelsOutput;
  canvas?: (target?: unknown) => HTMLCanvasElement | Promise<HTMLCanvasElement>;
}

interface RendererReadbackApi {
  gl?: WebGLRenderingContext | WebGL2RenderingContext;
  extract?: RendererExtractApi;
}

interface FinalizedOutputBundle {
  blobs: Record<string, Blob>;
  analyses: Record<string, OutputVideoAnalysis>;
  files: Record<string, FileSystemFileHandle>;
  streamedOutputIds: string[];
}

function pixelsContainNonBlackContent(pixels: ArrayLike<number>): boolean {
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] > 0 || pixels[index + 1] > 0 || pixels[index + 2] > 0) {
      return true;
    }
  }
  return false;
}

/**
 * How many encoded frames may be in flight (submitted but not yet drained) per
 * output before the producer is throttled. A window > 1 lets the next export
 * frame decode/composite while previous frames finish encoding, overlapping the
 * two dominant async stages; the bound keeps in-flight VideoFrames from growing
 * memory without limit when the encoder is the slower stage.
 */
const DEFAULT_ENCODE_QUEUE_FRAMES = 4;

/**
 * Frames an output may have submitted but not yet received back as packets.
 *
 * Mediabunny's own backpressure waits on `encodeQueueSize`, which only counts
 * frames the encoder has not yet *accepted*. An encoder slower than the render
 * accepts frames into its own pipeline far faster than it encodes them: a real
 * 2.5-minute export measured ~2,200 frames outstanding, so progress read 99%
 * with half the video unencoded and "finishing" spent minutes flushing it.
 * Bounding what has not come back as a packet keeps rendering, progress and
 * memory in step with the encoder.
 *
 * Generous on purpose: encoders hold frames for lookahead before emitting any
 * output, and a bound below that would never see a packet.
 */
const MAX_UNENCODED_FRAMES = 60;
/**
 * How long to wait for a packet before deciding the bound is below the
 * encoder's lookahead. Such an encoder emits nothing until fed more, so the
 * wait is released and that output's bound doubled, rather than deadlocking
 * the export or stalling on every later frame.
 */
const UNENCODED_STALL_MILLISECONDS = 2000;

export interface TextureOutputEncoderOptions {
  /** Frames in flight per output before the producer is throttled. Min 1. */
  encodeQueueSize?: number;
  onPhaseChange?: (phase: ExportPhase) => void;
  onDiagnostic?: (event: ExportDiagnostic) => void;
}

/** Captured outcome of a deferred encode; never rejects so it can sit unawaited. */
type SettledEncode =
  | { status: "fulfilled" }
  | { status: "rejected"; reason: unknown };

function throwIfRejected(result: SettledEncode): void {
  if (result.status === "rejected") {
    throw result.reason;
  }
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
  /**
   * Backpressure promises from `videoSource.add()` we have not awaited yet, in
   * submission order. Drained oldest-first once the window fills, and fully on
   * finalize(). Each entry is wrapped so it settles (never rejects) — a later
   * encode can fail before it becomes the oldest, so we capture the rejection at
   * queue time to avoid a transient unhandled rejection, then re-surface the
   * first failure when the entry is drained.
   */
  private pendingEncodes: Promise<SettledEncode>[] = [];
  private readonly encodeQueueFrames: number;
  private maxPendingEncodes = 0;
  private readonly abortController = new AbortController();
  private readonly fileTargets: ExportFileTarget[] = [];
  private abortPromise: Promise<void> | null = null;
  private finalized = false;
  private disposed = false;
  public isCommitting = false;
  private readonly onPhaseChange?: (phase: ExportPhase) => void;
  private readonly onDiagnostic?: (event: ExportDiagnostic) => void;

  constructor(
    app: Application,
    frameRate: number,
    definitions: OutputVideoDefinition[],
    options?: TextureOutputEncoderOptions,
  ) {
    this.app = app;
    this.onPhaseChange = options?.onPhaseChange;
    this.onDiagnostic = options?.onDiagnostic;
    if (definitions.length === 0) {
      throw new Error("TextureOutputEncoder requires at least one output");
    }

    this.outputStage = new Container();
    this.outputSprite = new Sprite();
    this.outputSprite.anchor.set(0);
    this.outputStage.addChild(this.outputSprite);

    this.frameRate = frameRate;
    this.definitions = definitions;
    this.encodeQueueFrames = Math.max(
      1,
      Math.floor(options?.encodeQueueSize ?? DEFAULT_ENCODE_QUEUE_FRAMES),
    );
  }

  public async start(): Promise<void> {
    if (this.started) return;

    try {
      for (const definition of this.definitions) {
        this.throwIfCancelled();
        const format = definition.format ?? "mp4";
        const isAlphaWebM = format === "webm";
        const mimeType = isAlphaWebM ? "video/webm" : "video/mp4";
        const encoding = outputEncodingSettings(format, definition);

        let target: BufferTarget | StreamTarget;
        let fileTarget: ExportFileTarget | undefined;

        if (definition.fileHandle && definition.outputTarget) {
          throw new Error("An output cannot have both a file handle and a stream target");
        }
        if (definition.outputTarget) {
          fileTarget = definition.outputTarget;
          this.fileTargets.push(fileTarget);
          target = fileTarget.target;
        } else if (definition.fileHandle) {
          // Keep the late-created stream reachable even if cancellation arrived
          // while the picker-backed createWritable operation was pending.
          fileTarget = new ExportFileTarget(
            await definition.fileHandle.createWritable(),
          );
          this.fileTargets.push(fileTarget);
          this.throwIfCancelled();
          target = fileTarget.target;
        } else {
          target = new BufferTarget();
        }

        const output = new Output({
          format: isAlphaWebM
            ? new WebMOutputFormat()
            : new Mp4OutputFormat({
                fastStart: fileTarget ? false : "in-memory",
              }),
          target,
        });

        const submissionTimes = this.onDiagnostic ? new Map<number, number>() : undefined;
        const encodeCounts: EncodeCounts = {
          submitted: 0, encoded: 0, limit: MAX_UNENCODED_FRAMES, packetWaiters: [],
        };
        const videoSource = new CanvasSource(this.app.canvas, {
          ...encoding.video,
          keyFrameInterval: definition.keyFrameInterval,
          onEncoderConfig: (config) => {
            this.onDiagnostic?.({
              kind: "encoder-config", outputId: definition.id,
              config: structuredClone(config),
            });
          },
          onEncodedPacket: (packet, metadata) => {
            encodeCounts.encoded += 1;
            const waiters = encodeCounts.packetWaiters;
            encodeCounts.packetWaiters = [];
            for (const resolve of waiters) resolve();
            if (submissionTimes) {
              const microseconds = Math.round(packet.timestamp * 1_000_000);
              // Packets can retain the precise timestamp or return whole
              // microseconds truncated by WebCodecs. Rounding the submission
              // can differ by 1 us (e.g. 2/30 s); keep matching by timestamp
              // rather than arrival order, since encoders can reorder packets.
              const key = [microseconds, microseconds + 1, microseconds - 1]
                .find((candidate) => submissionTimes.has(candidate));
              const startedAt = key === undefined ? undefined : submissionTimes.get(key);
              if (key !== undefined) submissionTimes.delete(key);
              this.onDiagnostic?.({
                kind: "video-packet", outputId: definition.id,
                timestamp: packet.timestamp, bytes: packet.byteLength,
                submissionToPacketMilliseconds: startedAt === undefined
                  ? null : performance.now() - startedAt,
              });
            }
            const decoderConfig = metadata?.decoderConfig;
            if (!isAlphaWebM && decoderConfig && decoderConfig.colorSpace?.fullRange == null) {
              // WebM can signal unknown range and keep the other color fields.
              // MP4's colr box requires a range bit. Mediabunny writes limited
              // range for partial metadata, so omit the box when range is
              // unknown and let the decoder use any H.264 bitstream signaling.
              delete decoderConfig.colorSpace;
            }
          },
        });
        output.addVideoTrack(videoSource, { frameRate: this.frameRate });

        let audioSource: AudioBufferSource | null = null;
        if (definition.includeAudio) {
          if (encoding.audio.codec === "aac") {
            await ensureAacEncoder(encoding.audio.bitrate);
            this.throwIfCancelled();
          }
          audioSource = new AudioBufferSource({
            ...encoding.audio,
          });
          output.addAudioTrack(audioSource);
        }

        this.outputs.push({
          definition,
          mimeType,
          output,
          target,
          videoSource,
          audioSource,
          fileTarget,
          submissionTimes,
          encodeCounts,
          measuredContent: false,
          hasVisibleContent: false,
          canMeasureContent: definition.contentProbe === "non_black_pixels",
        });
      }

      for (const output of this.outputs) {
        await this.interruptible(output.output.start());
      }
      this.maxPendingEncodes = this.encodeQueueFrames * this.outputs.length;
      this.started = true;
    } catch (error) {
      await this.abort();
      // A stream created after an earlier abort still needs to be discarded.
      await Promise.allSettled(this.fileTargets.map((target) => target.abort()));
      throw error;
    }
  }

  private throwIfCancelled(): void {
    if (this.abortController.signal.aborted) {
      throw new DOMException("Render cancelled", "AbortError");
    }
  }

  private async interruptible<T>(operation: Promise<T>): Promise<T> {
    const signal = this.abortController.signal;
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DOMException("Render cancelled", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([operation, cancelled]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  public abort(): Promise<void> {
    if (this.finalized || this.isCommitting) return Promise.resolve();
    this.abortController.abort();
    return (this.abortPromise ??= (async () => {
      const results = await Promise.allSettled([
        ...this.fileTargets.map((target) => target.abort()),
        ...this.outputs
          .filter(
            ({ output }) =>
              output.state !== "finalizing" && output.state !== "finalized",
          )
          .map(({ output }) => output.cancel()),
      ]);
      for (const result of results) {
        if (result.status === "rejected") {
          console.warn("Export cleanup failed", result.reason);
        }
      }
    })());
  }

  public async addAudioChunk(audioBuffer: AudioBuffer): Promise<void> {
    this.throwIfCancelled();
    for (const output of this.outputs) {
      if (output.audioSource) {
        await this.interruptible(output.audioSource.add(audioBuffer));
      }
    }
  }

  public async closeAudioTracks(): Promise<void> {
    if (this.audioClosed) return;
    this.throwIfCancelled();
    for (const output of this.outputs) {
      if (output.audioSource) {
        await this.interruptible(Promise.resolve(output.audioSource.close()));
      }
    }
    this.audioClosed = true;
  }

  public async addTextureFrame(
    sourceTexture: Texture,
    timestamp: number,
    frameDuration: number,
  ): Promise<void> {
    this.throwIfCancelled();
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
      // CanvasSource.add() snapshots the canvas into a VideoSample synchronously
      // and returns a promise that only signals encoder backpressure. Defer that
      // await so the caller's next frame can decode/composite while this frame
      // encodes; the synchronous snapshot means the shared canvas/frameTexture
      // is free to be overwritten as soon as add() returns. (Promise.resolve
      // normalises the return so the queue is always thenable.)
      output.submissionTimes?.set(Math.round(timestamp * 1_000_000), performance.now());
      output.encodeCounts.submitted += 1;
      this.pendingEncodes.push(
        Promise.resolve(output.videoSource.add(timestamp, frameDuration)).then(
          (): SettledEncode => ({ status: "fulfilled" }),
          (reason: unknown): SettledEncode => ({ status: "rejected", reason }),
        ),
      );
    }

    await this.applyEncodeBackpressure();
  }

  /**
   * Throttle the producer once more than `maxPendingEncodes` frames are in
   * flight by awaiting the oldest submissions until the window has room again.
   */
  private async applyEncodeBackpressure(): Promise<void> {
    while (this.pendingEncodes.length > this.maxPendingEncodes) {
      const oldest = this.pendingEncodes.shift();
      if (oldest) {
        throwIfRejected(await this.interruptible(oldest));
      }
    }
    await this.waitForEncoderToCatchUp();
  }

  /**
   * Hold the producer while any output has more frames outstanding than its
   * bound (initially {@link MAX_UNENCODED_FRAMES}), once it has produced its
   * first packet. A wait that sees no packet
   * for {@link UNENCODED_STALL_MILLISECONDS} doubles that output's bound, so an
   * encoder that buffers more than the bound cannot deadlock the export.
   */
  private async waitForEncoderToCatchUp(): Promise<void> {
    for (const output of this.outputs) {
      const counts = output.encodeCounts;
      // Until the first packet the encoder is still filling its lookahead;
      // holding the producer then can only delay the packet it is waiting for.
      if (counts.encoded === 0) continue;
      while (counts.submitted - counts.encoded > counts.limit) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let wake!: () => void;
        let woken: "packet" | "stall";
        try {
          woken = await this.interruptible(Promise.race([
            new Promise<"packet">((resolve) => {
              wake = () => resolve("packet");
              counts.packetWaiters.push(wake);
            }),
            new Promise<"stall">((resolve) => {
              timer = setTimeout(() => resolve("stall"), UNENCODED_STALL_MILLISECONDS);
            }),
          ]));
        } finally {
          clearTimeout(timer);
          // A stall or cancellation leaves the waiter behind; drop it.
          counts.packetWaiters = counts.packetWaiters.filter((waiter) => waiter !== wake);
        }
        if (woken === "stall") counts.limit *= 2;
      }
    }
  }

  /**
   * Await every outstanding encode before returning. All are observed (so none
   * can leak as an unhandled rejection) and the first failure is re-thrown only
   * after the whole queue has settled.
   */
  public async flushPendingEncodes(): Promise<void> {
    const pending = this.pendingEncodes;
    this.pendingEncodes = [];
    const results = await this.interruptible(Promise.all(pending));
    const firstFailure = results.find(
      (result): result is Extract<SettledEncode, { status: "rejected" }> =>
        result.status === "rejected",
    );
    if (firstFailure) {
      throw firstFailure.reason;
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
        return pixelsContainNonBlackContent(
          extract.pixels(this.outputStage).pixels,
        );
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
    this.throwIfCancelled();
    this.onPhaseChange?.("finalizing");
    // Drain any frames still encoding before closing the sources.
    await this.measureFinishing("encoder-drain", undefined, () => this.flushPendingEncodes());
    for (const output of this.outputs) {
      await this.measureFinishing("video-close", output.definition.id,
        () => this.interruptible(Promise.resolve(output.videoSource.close())));
      await this.measureFinishing("mux-finalize", output.definition.id,
        () => this.interruptible(output.output.finalize()));
    }

    const blobs: Record<string, Blob> = {};
    for (const output of this.outputs) {
      if (!output.fileTarget) {
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

    this.throwIfCancelled();
    const files: Record<string, FileSystemFileHandle> = {};
    const streamedOutputIds: string[] = [];
    if (this.fileTargets.length > 0) {
      // close() is the commit boundary. Cancellation is no longer safe once
      // replacement of the destination has begun; keep the UI waiting for it.
      this.isCommitting = true;
      this.onPhaseChange?.("saving");
      try {
        for (const output of this.outputs) {
          if (output.fileTarget) {
            await this.measureFinishing("output-commit", output.definition.id,
              () => output.fileTarget!.commit());
            if (output.definition.fileHandle) {
              files[output.definition.id] = output.definition.fileHandle;
            } else {
              streamedOutputIds.push(output.definition.id);
            }
          }
        }
      } finally {
        this.isCommitting = false;
      }
    }
    this.finalized = true;
    return { blobs, analyses, files, streamedOutputIds };
  }

  private async measureFinishing(
    stage: Extract<ExportDiagnostic, { kind: "finishing" }>["stage"],
    outputId: string | undefined,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (!this.onDiagnostic) return operation();
    const startedAt = performance.now();
    this.onDiagnostic({ kind: "finishing", stage, outputId, state: "started" });
    await operation();
    this.onDiagnostic({ kind: "finishing", stage, outputId, state: "completed",
      elapsedMilliseconds: performance.now() - startedAt });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.abort();
    // Queued entries already capture their own rejection (see pendingEncodes),
    // so dropping them on an aborted/failed teardown can't leak an unhandled
    // rejection — just release the references.
    this.pendingEncodes = [];
    this.outputStage.destroy({ children: true });
  }
}
