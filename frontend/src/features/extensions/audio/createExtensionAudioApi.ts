import { AudioBufferSink } from "mediabunny";
import type { Input, InputAudioTrack, WrappedAudioBuffer } from "mediabunny";
import type {
  ExtensionApiScope,
  ExtensionAudioApi,
  ExtensionAudioClipSnapshot,
  ExtensionAudioReadFailureCode,
  ExtensionAudioReadRequest,
  ExtensionAudioSourceSnapshot,
  ExtensionAudioTrackSnapshot,
} from "../types";
import { combineRevisionSources, createRevisionRelay } from "../../../core/shell/revisionRelay";
import { bindOwnerScopedSubscribe } from "../utils/ownerScopedSubscribe";
import {
  getTimelineClipById,
  getTimelineModelRevisionSource,
  getTimelineModelState,
} from "../../timeline/api";
import { getAssetById, getAssetInput, useAssetStore } from "../../userAssets";
import type { TimelineClip } from "../../../types/TimelineTypes";

const DEFAULT_SAMPLES_PER_PEAK = 256;
const MAX_PCM_FRAMES = 4_000_000;
const MAX_WAVEFORM_SOURCE_FRAMES = 48_000_000;
const MAX_WAVEFORM_PEAKS = 1_000_000;

interface ExtensionAudioApiDependencies {
  readonly getInput?: (assetId: string) => Promise<Input | null>;
  readonly createSink?: (track: InputAudioTrack) => Pick<AudioBufferSink, "buffers">;
}

interface AudioSourceHandle {
  readonly source: ExtensionAudioSourceSnapshot;
  readonly track: InputAudioTrack;
}

interface NormalizedReadRange {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly frameCount: number;
}

const timelineRelay = getTimelineModelRevisionSource();
const assetRelay = createRevisionRelay(useAssetStore, (state) => [state.assets]);
const audioRelay = combineRevisionSources(timelineRelay, assetRelay);

function failure(code: ExtensionAudioReadFailureCode, message: string) {
  return Object.freeze({ ok: false as const, code, message });
}

function assertAssetId(assetId: string): void {
  if (typeof assetId !== "string" || assetId.trim().length === 0) {
    throw new TypeError("Audio analysis requires a non-empty asset ID.");
  }
}

function assertReadRequest(request: ExtensionAudioReadRequest | undefined): void {
  if (
    (request?.startSeconds !== undefined &&
      !Number.isFinite(request.startSeconds)) ||
    (request?.endSeconds !== undefined && !Number.isFinite(request.endSeconds))
  ) {
    throw new RangeError("Audio analysis range values must be finite.");
  }
}

function abortIfNeeded(scopeSignal: AbortSignal, requestSignal?: AbortSignal): void {
  if (scopeSignal.aborted || requestSignal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isAudioBearingClip(clip: TimelineClip): clip is TimelineClip & {
  type: "audio" | "video";
  assetId: string;
} {
  if (clip.type !== "audio" && clip.type !== "video") return false;
  const asset = getAssetById(clip.assetId);
  return clip.type === "audio" || asset?.hasAudio === true;
}

function toAudioClipSnapshot(
  clip: TimelineClip & { type: "audio" | "video"; assetId: string },
): ExtensionAudioClipSnapshot {
  return Object.freeze({
    id: clip.id,
    assetId: clip.assetId,
    type: clip.type,
    trackId: clip.trackId,
    startTicks: clip.start,
    durationTicks: clip.timelineDuration,
    sourceOffsetTicks: clip.offset,
    croppedSourceDurationTicks: clip.croppedSourceDuration,
    isMuted: clip.isMuted === true,
  });
}

function listAudioClips(): readonly ExtensionAudioClipSnapshot[] {
  return Object.freeze(
    getTimelineModelState().clips.filter(isAudioBearingClip).map(toAudioClipSnapshot),
  );
}

function listAudioTracks(): readonly ExtensionAudioTrackSnapshot[] {
  const state = getTimelineModelState();
  const clipsByTrack = new Map<string, Array<{ id: string; start: number }>>();
  for (const clip of state.clips) {
    if (!isAudioBearingClip(clip)) continue;
    const clips = clipsByTrack.get(clip.trackId) ?? [];
    clips.push({ id: clip.id, start: clip.start });
    clipsByTrack.set(clip.trackId, clips);
  }

  return Object.freeze(
    state.tracks.flatMap((track, index) => {
      const clipIds = (clipsByTrack.get(track.id) ?? [])
        .sort((left, right) => left.start - right.start)
        .map((clip) => clip.id);
      if (track.type !== "audio" && clipIds.length === 0) return [];
      return [
        Object.freeze({
          id: track.id,
          index,
          label: track.label,
          type: track.type ?? null,
          isVisible: track.isVisible,
          isMuted: track.isMuted,
          isLocked: track.isLocked,
          clipIds: Object.freeze([...clipIds]),
        }),
      ];
    }),
  );
}

async function openSource(
  assetId: string,
  scopeSignal: AbortSignal,
  requestSignal: AbortSignal | undefined,
  loadInput: (assetId: string) => Promise<Input | null>,
): Promise<AudioSourceHandle | ReturnType<typeof failure>> {
  assertAssetId(assetId);
  abortIfNeeded(scopeSignal, requestSignal);
  if (!getAssetById(assetId)) {
    return failure("asset_not_found", `Asset '${assetId}' was not found.`);
  }

  const input = await loadInput(assetId);
  abortIfNeeded(scopeSignal, requestSignal);
  if (!input) {
    return failure("decode_failed", `Asset '${assetId}' could not be opened.`);
  }
  const track = await input.getPrimaryAudioTrack();
  abortIfNeeded(scopeSignal, requestSignal);
  if (!track || !(await track.canDecode())) {
    return failure("no_audio", `Asset '${assetId}' has no decodable audio stream.`);
  }

  // Mediabunny names this `computeDuration`, but the value is the stream's end
  // timestamp. Subtract the first timestamp before publishing a true span.
  const [endTimestampSeconds, firstTimestampSeconds] = await Promise.all([
    track.computeDuration(),
    track.getFirstTimestamp(),
  ]);
  abortIfNeeded(scopeSignal, requestSignal);
  if (
    !Number.isFinite(endTimestampSeconds) ||
    !Number.isFinite(firstTimestampSeconds) ||
    endTimestampSeconds < firstTimestampSeconds
  ) {
    return failure(
      "decode_failed",
      `Asset '${assetId}' reported invalid audio stream timestamps.`,
    );
  }
  return {
    track,
    source: Object.freeze({
      assetId,
      sampleRate: track.sampleRate,
      numberOfChannels: track.numberOfChannels,
      durationSeconds: endTimestampSeconds - firstTimestampSeconds,
      firstTimestampSeconds,
      endTimestampSeconds,
      maxPcmFramesPerRead: MAX_PCM_FRAMES,
    }),
  };
}

function normalizeRange(
  source: ExtensionAudioSourceSnapshot,
  request: ExtensionAudioReadRequest | undefined,
): NormalizedReadRange | ReturnType<typeof failure> {
  const requestedStart = request?.startSeconds ?? source.firstTimestampSeconds;
  const requestedEnd = request?.endSeconds ?? source.endTimestampSeconds;
  if (!Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd)) {
    throw new RangeError("Audio analysis range values must be finite.");
  }
  const startSeconds = Math.max(source.firstTimestampSeconds, requestedStart);
  const endSeconds = Math.min(source.endTimestampSeconds, requestedEnd);
  if (endSeconds <= startSeconds) {
    return failure("invalid_range", "Audio analysis range is empty or outside the source.");
  }
  return {
    startSeconds,
    endSeconds,
    frameCount: Math.ceil((endSeconds - startSeconds) * source.sampleRate),
  };
}

function copyWrappedBuffer(
  wrapped: WrappedAudioBuffer,
  source: ExtensionAudioSourceSnapshot,
  range: NormalizedReadRange,
  write: (channel: number, sourceData: Float32Array, sourceStart: number, length: number, destinationStart: number) => void,
): boolean {
  const buffer = wrapped.buffer;
  if (buffer.sampleRate !== source.sampleRate) {
    throw new Error("The decoded audio stream changed sample rate.");
  }
  const overlapStart = Math.max(range.startSeconds, wrapped.timestamp);
  const overlapEnd = Math.min(range.endSeconds, wrapped.timestamp + wrapped.duration);
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

export function createExtensionAudioApi(
  scope: ExtensionApiScope,
  dependencies: ExtensionAudioApiDependencies = {},
): ExtensionAudioApi {
  const loadInput = dependencies.getInput ?? getAssetInput;
  const createSink = dependencies.createSink ?? ((track) => new AudioBufferSink(track));

  const api: ExtensionAudioApi = {
    listClips: listAudioClips,
    getClip: (clipId) => {
      const clip = getTimelineClipById(clipId);
      return clip && isAudioBearingClip(clip)
        ? toAudioClipSnapshot(clip)
        : undefined;
    },
    listTracks: listAudioTracks,
    subscribe: bindOwnerScopedSubscribe(scope, audioRelay, "Audio"),
    getRevision: () => audioRelay.getRevision(),
    inspect: async (assetId, request) => {
      assertAssetId(assetId);
      try {
        const opened = await openSource(
          assetId,
          scope.signal,
          request?.signal,
          loadInput,
        );
        if ("ok" in opened) return opened;
        return Object.freeze({ ok: true as const, source: opened.source });
      } catch (error) {
        if (isAbortError(error)) throw error;
        return failure(
          "decode_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    readPcm: async (assetId, request) => {
      assertAssetId(assetId);
      assertReadRequest(request);
      try {
        const opened = await openSource(
          assetId,
          scope.signal,
          request?.signal,
          loadInput,
        );
        if ("ok" in opened) return opened;
        const range = normalizeRange(opened.source, request);
        if ("ok" in range) return range;
        if (range.frameCount > MAX_PCM_FRAMES) {
          return failure(
            "range_too_large",
            `PCM reads are limited to ${MAX_PCM_FRAMES} source frames per request.`,
          );
        }

        const channels = Array.from(
          { length: opened.source.numberOfChannels },
          () => new Float32Array(range.frameCount),
        );
        let decoded = false;
        const sink = createSink(opened.track);
        for await (const wrapped of sink.buffers(range.startSeconds, range.endSeconds)) {
          abortIfNeeded(scope.signal, request?.signal);
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
        if (!decoded) {
          return failure("decode_failed", "The requested audio range produced no PCM.");
        }
        return Object.freeze({
          ok: true as const,
          source: opened.source,
          startSeconds: range.startSeconds,
          durationSeconds: range.frameCount / opened.source.sampleRate,
          channels: Object.freeze(channels),
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        return failure(
          "decode_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    readWaveform: async (assetId, request) => {
      assertAssetId(assetId);
      assertReadRequest(request);
      const samplesPerPeak = request?.samplesPerPeak ?? DEFAULT_SAMPLES_PER_PEAK;
      if (!Number.isInteger(samplesPerPeak) || samplesPerPeak <= 0) {
        throw new RangeError("samplesPerPeak must be a positive integer.");
      }
      try {
        const opened = await openSource(
          assetId,
          scope.signal,
          request?.signal,
          loadInput,
        );
        if ("ok" in opened) return opened;
        const range = normalizeRange(opened.source, request);
        if ("ok" in range) return range;
        const peakCount = Math.ceil(range.frameCount / samplesPerPeak);
        if (
          range.frameCount > MAX_WAVEFORM_SOURCE_FRAMES ||
          peakCount > MAX_WAVEFORM_PEAKS
        ) {
          return failure(
            "range_too_large",
            "Waveform reads exceed the host's decoded-frame or peak limit.",
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
        const sink = createSink(opened.track);
        for await (const wrapped of sink.buffers(range.startSeconds, range.endSeconds)) {
          abortIfNeeded(scope.signal, request?.signal);
          decoded =
            copyWrappedBuffer(
              wrapped,
              opened.source,
              range,
              (channel, sourceData, sourceStart, length, destinationStart) => {
                const output = channels[channel]!;
                for (let offset = 0; offset < length; offset += 1) {
                  const peakIndex = Math.floor(
                    (destinationStart + offset) / samplesPerPeak,
                  );
                  const value = sourceData[sourceStart + offset] ?? 0;
                  output.min[peakIndex] = Math.min(output.min[peakIndex] ?? 1, value);
                  output.max[peakIndex] = Math.max(output.max[peakIndex] ?? -1, value);
                  output.seen[peakIndex] = 1;
                }
              },
            ) || decoded;
        }
        if (!decoded) {
          return failure("decode_failed", "The requested audio range produced no waveform.");
        }
        return Object.freeze({
          ok: true as const,
          source: opened.source,
          startSeconds: range.startSeconds,
          durationSeconds: range.frameCount / opened.source.sampleRate,
          samplesPerPeak,
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
        if (isAbortError(error)) throw error;
        return failure(
          "decode_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
  return Object.freeze(api);
}
