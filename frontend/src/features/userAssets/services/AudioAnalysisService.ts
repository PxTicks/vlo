import { AudioBufferSink } from "mediabunny";
import type {
  Input,
  InputAudioTrack,
  WrappedAudioBuffer,
} from "mediabunny";
import { readMediaTimestampRange } from "../../../core/time";
import { useAssetStore } from "../useAssetStore";

export type AudioAnalysisFailureCode =
  | "no_audio"
  | "decode_failed"
  | "invalid_range"
  | "range_too_large";

export class AudioAnalysisError extends Error {
  readonly code: AudioAnalysisFailureCode;

  constructor(
    code: AudioAnalysisFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AudioAnalysisError";
    this.code = code;
  }
}

export interface AudioAnalysisSource {
  readonly assetId: string;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly durationSeconds: number;
  readonly firstTimestampSeconds: number;
  readonly endTimestampSeconds: number;
}

export interface AudioAnalysisCancellationOptions {
  readonly signals?: readonly AbortSignal[];
}

export interface AudioAnalysisReadRequest
  extends AudioAnalysisCancellationOptions {
  readonly startSeconds?: number;
  readonly endSeconds?: number;
}

export interface AudioAnalysisPcmRequest extends AudioAnalysisReadRequest {
  readonly maxFrames?: number;
}

export interface AudioAnalysisWaveformRequest
  extends AudioAnalysisReadRequest {
  readonly samplesPerPeak: number;
  readonly maxSourceFrames?: number;
  readonly maxPeaks?: number;
  /** Anchor for stable host caches; ordinary reads anchor at their start. */
  readonly peakOriginSeconds?: number;
}

export interface AudioAnalysisPcm {
  readonly source: AudioAnalysisSource;
  readonly startSeconds: number;
  readonly durationSeconds: number;
  readonly channels: readonly Float32Array[];
}

export interface AudioAnalysisWaveformChannel {
  readonly min: Float32Array;
  readonly max: Float32Array;
}

export interface AudioAnalysisWaveform {
  readonly source: AudioAnalysisSource;
  readonly startSeconds: number;
  readonly durationSeconds: number;
  readonly samplesPerPeak: number;
  /** Peak index relative to `peakOriginSeconds`. */
  readonly firstPeakIndex: number;
  readonly channels: readonly AudioAnalysisWaveformChannel[];
}

export interface AudioAnalysisReader {
  inspect(
    assetId: string,
    options?: AudioAnalysisCancellationOptions,
  ): Promise<AudioAnalysisSource>;
  readPcm(
    assetId: string,
    request?: AudioAnalysisPcmRequest,
  ): Promise<AudioAnalysisPcm>;
  readWaveform(
    assetId: string,
    request: AudioAnalysisWaveformRequest,
  ): Promise<AudioAnalysisWaveform>;
}

export interface AudioAnalysisServiceDependencies {
  readonly getInput: (assetId: string) => Promise<Input | null>;
  readonly createSink?: (
    track: InputAudioTrack,
  ) => Pick<AudioBufferSink, "buffers">;
}

interface OpenAudioSource {
  readonly source: AudioAnalysisSource;
  readonly track: InputAudioTrack;
}

interface NormalizedReadRange {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly startFrame: number;
  readonly frameCount: number;
}

function assertAssetId(assetId: string): void {
  if (typeof assetId !== "string" || assetId.trim().length === 0) {
    throw new TypeError("Audio analysis requires a non-empty asset ID.");
  }
}

function throwIfAborted(signals: readonly AbortSignal[] = []): void {
  if (signals.some((signal) => signal.aborted)) {
    throw new DOMException("Aborted", "AbortError");
  }
}

export function isAudioAnalysisAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function asDecodeError(error: unknown): AudioAnalysisError {
  if (error instanceof AudioAnalysisError) return error;
  return new AudioAnalysisError(
    "decode_failed",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

function isProgrammingError(error: unknown): boolean {
  return error instanceof RangeError || error instanceof TypeError;
}

function assertReadRequest(request: AudioAnalysisReadRequest | undefined): void {
  if (
    (request?.startSeconds !== undefined &&
      !Number.isFinite(request.startSeconds)) ||
    (request?.endSeconds !== undefined &&
      !Number.isFinite(request.endSeconds))
  ) {
    throw new RangeError("Audio analysis range values must be finite.");
  }
}

function normalizeRange(
  source: AudioAnalysisSource,
  request: AudioAnalysisReadRequest | undefined,
): NormalizedReadRange {
  assertReadRequest(request);
  const requestedStart = request?.startSeconds ?? source.firstTimestampSeconds;
  const requestedEnd = request?.endSeconds ?? source.endTimestampSeconds;
  const startSeconds = Math.max(source.firstTimestampSeconds, requestedStart);
  const endSeconds = Math.min(source.endTimestampSeconds, requestedEnd);
  if (endSeconds <= startSeconds) {
    throw new AudioAnalysisError(
      "invalid_range",
      "Audio analysis range is empty or outside the source.",
    );
  }
  const startFrame = Math.round(startSeconds * source.sampleRate);
  return {
    startSeconds,
    endSeconds,
    startFrame,
    frameCount: Math.ceil((endSeconds - startSeconds) * source.sampleRate),
  };
}

function copyWrappedBuffer(
  wrapped: WrappedAudioBuffer,
  source: AudioAnalysisSource,
  range: NormalizedReadRange,
  write: (
    channel: number,
    sourceData: Float32Array,
    sourceStart: number,
    length: number,
    destinationStart: number,
  ) => void,
): boolean {
  const buffer = wrapped.buffer;
  if (buffer.sampleRate !== source.sampleRate) {
    throw new AudioAnalysisError(
      "decode_failed",
      "The decoded audio stream changed sample rate.",
    );
  }
  const overlapStart = Math.max(range.startSeconds, wrapped.timestamp);
  const overlapEnd = Math.min(
    range.endSeconds,
    wrapped.timestamp + wrapped.duration,
  );
  if (overlapEnd <= overlapStart) return false;

  const sourceStart = Math.max(
    0,
    Math.round((overlapStart - wrapped.timestamp) * source.sampleRate),
  );
  const destinationStart = Math.max(
    0,
    Math.round((overlapStart - range.startSeconds) * source.sampleRate),
  );
  const requestedLength = Math.max(
    0,
    Math.round((overlapEnd - overlapStart) * source.sampleRate),
  );
  const length = Math.min(
    requestedLength,
    buffer.length - sourceStart,
    range.frameCount - destinationStart,
  );
  if (length <= 0) return false;

  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    const sourceChannel =
      channel < buffer.numberOfChannels
        ? buffer.getChannelData(channel)
        : new Float32Array(buffer.length);
    write(channel, sourceChannel, sourceStart, length, destinationStart);
  }
  return true;
}

export class AudioAnalysisService implements AudioAnalysisReader {
  private readonly openSources = new Map<string, OpenAudioSource>();
  private readonly getInput: AudioAnalysisServiceDependencies["getInput"];
  private readonly createSink: NonNullable<
    AudioAnalysisServiceDependencies["createSink"]
  >;

  constructor(dependencies: AudioAnalysisServiceDependencies) {
    this.getInput = dependencies.getInput;
    this.createSink =
      dependencies.createSink ?? ((track) => new AudioBufferSink(track));
  }

  async inspect(
    assetId: string,
    options: AudioAnalysisCancellationOptions = {},
  ): Promise<AudioAnalysisSource> {
    return (await this.openSource(assetId, options)).source;
  }

  async readPcm(
    assetId: string,
    request: AudioAnalysisPcmRequest = {},
  ): Promise<AudioAnalysisPcm> {
    try {
      const opened = await this.openSource(assetId, request);
      const range = normalizeRange(opened.source, request);
      if (
        request.maxFrames !== undefined &&
        range.frameCount > request.maxFrames
      ) {
        throw new AudioAnalysisError(
          "range_too_large",
          `PCM reads are limited to ${request.maxFrames} source frames per request.`,
        );
      }

      const channels = Array.from(
        { length: opened.source.numberOfChannels },
        () => new Float32Array(range.frameCount),
      );
      let decoded = false;
      const sink = this.createSink(opened.track);
      for await (const wrapped of sink.buffers(
        range.startSeconds,
        range.endSeconds,
      )) {
        throwIfAborted(request.signals);
        decoded =
          copyWrappedBuffer(
            wrapped,
            opened.source,
            range,
            (channel, sourceData, sourceStart, length, destinationStart) => {
              channels[channel]!.set(
                sourceData.subarray(sourceStart, sourceStart + length),
                destinationStart,
              );
            },
          ) || decoded;
      }
      throwIfAborted(request.signals);
      if (!decoded) {
        throw new AudioAnalysisError(
          "decode_failed",
          "The requested audio range produced no PCM.",
        );
      }
      return Object.freeze({
        source: opened.source,
        startSeconds: range.startSeconds,
        durationSeconds: range.frameCount / opened.source.sampleRate,
        channels: Object.freeze(channels),
      });
    } catch (error) {
      if (isAudioAnalysisAbortError(error)) throw error;
      if (isProgrammingError(error)) throw error;
      throw asDecodeError(error);
    }
  }

  async readWaveform(
    assetId: string,
    request: AudioAnalysisWaveformRequest,
  ): Promise<AudioAnalysisWaveform> {
    if (!Number.isInteger(request.samplesPerPeak) || request.samplesPerPeak <= 0) {
      throw new RangeError("samplesPerPeak must be a positive integer.");
    }
    if (
      request.peakOriginSeconds !== undefined &&
      !Number.isFinite(request.peakOriginSeconds)
    ) {
      throw new RangeError("peakOriginSeconds must be finite.");
    }

    try {
      const opened = await this.openSource(assetId, request);
      const range = normalizeRange(opened.source, request);
      const originFrame = Math.round(
        (request.peakOriginSeconds ?? range.startSeconds) *
          opened.source.sampleRate,
      );
      const firstPeakIndex = Math.floor(
        (range.startFrame - originFrame) / request.samplesPerPeak,
      );
      const lastPeakExclusive = Math.ceil(
        (range.startFrame + range.frameCount - originFrame) /
          request.samplesPerPeak,
      );
      const peakCount = Math.max(0, lastPeakExclusive - firstPeakIndex);
      if (
        (request.maxSourceFrames !== undefined &&
          range.frameCount > request.maxSourceFrames) ||
        (request.maxPeaks !== undefined && peakCount > request.maxPeaks)
      ) {
        throw new AudioAnalysisError(
          "range_too_large",
          "Waveform reads exceed the decoded-frame or peak limit.",
        );
      }

      const channels = Array.from(
        { length: opened.source.numberOfChannels },
        () => ({
          min: new Float32Array(peakCount).fill(1),
          max: new Float32Array(peakCount).fill(-1),
          seen: new Uint8Array(peakCount),
        }),
      );
      let decoded = false;
      const sink = this.createSink(opened.track);
      for await (const wrapped of sink.buffers(
        range.startSeconds,
        range.endSeconds,
      )) {
        throwIfAborted(request.signals);
        decoded =
          copyWrappedBuffer(
            wrapped,
            opened.source,
            range,
            (channel, sourceData, sourceStart, length, destinationStart) => {
              const output = channels[channel]!;
              for (let offset = 0; offset < length; offset += 1) {
                const absoluteFrame =
                  range.startFrame + destinationStart + offset;
                const peakIndex =
                  Math.floor(
                    (absoluteFrame - originFrame) / request.samplesPerPeak,
                  ) - firstPeakIndex;
                const value = sourceData[sourceStart + offset] ?? 0;
                output.min[peakIndex] = Math.min(
                  output.min[peakIndex] ?? 1,
                  value,
                );
                output.max[peakIndex] = Math.max(
                  output.max[peakIndex] ?? -1,
                  value,
                );
                output.seen[peakIndex] = 1;
              }
            },
          ) || decoded;
      }
      throwIfAborted(request.signals);
      if (!decoded) {
        throw new AudioAnalysisError(
          "decode_failed",
          "The requested audio range produced no waveform.",
        );
      }

      return Object.freeze({
        source: opened.source,
        startSeconds: range.startSeconds,
        durationSeconds: range.frameCount / opened.source.sampleRate,
        samplesPerPeak: request.samplesPerPeak,
        firstPeakIndex,
        channels: Object.freeze(
          channels.map((channel) => {
            for (let index = 0; index < channel.seen.length; index += 1) {
              if (channel.seen[index]) continue;
              channel.min[index] = 0;
              channel.max[index] = 0;
            }
            return Object.freeze({ min: channel.min, max: channel.max });
          }),
        ),
      });
    } catch (error) {
      if (isAudioAnalysisAbortError(error)) throw error;
      if (isProgrammingError(error)) throw error;
      throw asDecodeError(error);
    }
  }

  private async openSource(
    assetId: string,
    options: AudioAnalysisCancellationOptions,
  ): Promise<OpenAudioSource> {
    assertAssetId(assetId);
    throwIfAborted(options.signals);
    const cached = this.openSources.get(assetId);
    if (cached) return cached;
    try {
      const input = await this.getInput(assetId);
      throwIfAborted(options.signals);
      if (!input) {
        throw new AudioAnalysisError(
          "decode_failed",
          `Asset '${assetId}' could not be opened.`,
        );
      }
      const track = await input.getPrimaryAudioTrack();
      throwIfAborted(options.signals);
      if (!track) {
        throw new AudioAnalysisError(
          "no_audio",
          `Asset '${assetId}' has no decodable audio stream.`,
        );
      }
      const canDecode = await track.canDecode();
      throwIfAborted(options.signals);
      if (!canDecode) {
        throw new AudioAnalysisError(
          "no_audio",
          `Asset '${assetId}' has no decodable audio stream.`,
        );
      }

      const timestampRange = await readMediaTimestampRange(track);
      throwIfAborted(options.signals);
      if (!timestampRange) {
        throw new AudioAnalysisError(
          "decode_failed",
          `Asset '${assetId}' reported invalid audio stream timestamps.`,
        );
      }
      if (
        !Number.isFinite(track.sampleRate) ||
        track.sampleRate <= 0 ||
        !Number.isInteger(track.numberOfChannels) ||
        track.numberOfChannels <= 0
      ) {
        throw new AudioAnalysisError(
          "decode_failed",
          `Asset '${assetId}' reported invalid audio stream dimensions.`,
        );
      }
      const opened: OpenAudioSource = {
        track,
        source: Object.freeze({
          assetId,
          sampleRate: track.sampleRate,
          numberOfChannels: track.numberOfChannels,
          durationSeconds: timestampRange.durationSeconds,
          firstTimestampSeconds: timestampRange.firstTimestampSeconds,
          endTimestampSeconds: timestampRange.endTimestampSeconds,
        }),
      };
      this.openSources.set(assetId, opened);
      return opened;
    } catch (error) {
      if (isAudioAnalysisAbortError(error)) throw error;
      throw asDecodeError(error);
    }
  }
}

export const audioAnalysisService = new AudioAnalysisService({
  getInput: (assetId) => useAssetStore.getState().getInput(assetId),
});
