import type {
  ExtensionApiScope,
  ExtensionAudioApi,
  ExtensionAudioClipSnapshot,
  ExtensionAudioReadFailureCode,
  ExtensionAudioSourceSnapshot,
  ExtensionAudioTrackSnapshot,
} from "../types";
import {
  combineRevisionSources,
  createRevisionRelay,
} from "../../../core/shell/revisionRelay";
import { bindOwnerScopedSubscribe } from "../utils/ownerScopedSubscribe";
import {
  getTimelineClipById,
  getTimelineModelRevisionSource,
  getTimelineModelState,
} from "../../timeline/api";
import {
  AudioAnalysisError,
  audioAnalysisService,
  getAssetById,
  isAudioAnalysisAbortError,
  useAssetStore,
  type AudioAnalysisReader,
  type AudioAnalysisSource,
} from "../../userAssets";
import type { TimelineClip } from "../../../types/TimelineTypes";

const DEFAULT_SAMPLES_PER_PEAK = 256;
const MAX_PCM_FRAMES = 4_000_000;
const MAX_WAVEFORM_SOURCE_FRAMES = 48_000_000;
const MAX_WAVEFORM_PEAKS = 1_000_000;

interface ExtensionAudioApiDependencies {
  readonly analysis?: AudioAnalysisReader;
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

function getSignals(
  scopeSignal: AbortSignal,
  requestSignal?: AbortSignal,
): readonly AbortSignal[] {
  return requestSignal ? [scopeSignal, requestSignal] : [scopeSignal];
}

function toSourceSnapshot(
  source: AudioAnalysisSource,
): ExtensionAudioSourceSnapshot {
  return Object.freeze({
    ...source,
    maxPcmFramesPerRead: MAX_PCM_FRAMES,
  });
}

function getAnalysisFailure(error: unknown) {
  if (error instanceof AudioAnalysisError) {
    return failure(error.code, error.message);
  }
  return failure(
    "decode_failed",
    error instanceof Error ? error.message : String(error),
  );
}

async function toAudioResult<TResult>(
  operation: () => Promise<TResult>,
): Promise<TResult | ReturnType<typeof failure>> {
  try {
    return await operation();
  } catch (error) {
    if (isAudioAnalysisAbortError(error)) throw error;
    if (error instanceof RangeError || error instanceof TypeError) throw error;
    return getAnalysisFailure(error);
  }
}

function assertReadRequest(
  startSeconds: number | undefined,
  endSeconds: number | undefined,
): void {
  if (
    (startSeconds !== undefined && !Number.isFinite(startSeconds)) ||
    (endSeconds !== undefined && !Number.isFinite(endSeconds))
  ) {
    throw new RangeError("Audio analysis range values must be finite.");
  }
}

function assertRequestPreconditions(
  assetId: string,
  scopeSignal: AbortSignal,
  requestSignal?: AbortSignal,
  validateRequest?: () => void,
): ReturnType<typeof failure> | null {
  assertAssetId(assetId);
  validateRequest?.();
  if (scopeSignal.aborted || requestSignal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  return getAssetById(assetId)
    ? null
    : failure("asset_not_found", `Asset '${assetId}' was not found.`);
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
    getTimelineModelState()
      .clips.filter(isAudioBearingClip)
      .map(toAudioClipSnapshot),
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

export function createExtensionAudioApi(
  scope: ExtensionApiScope,
  dependencies: ExtensionAudioApiDependencies = {},
): ExtensionAudioApi {
  const analysis = dependencies.analysis ?? audioAnalysisService;

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
      const missing = assertRequestPreconditions(
        assetId,
        scope.signal,
        request?.signal,
      );
      if (missing) return missing;
      return toAudioResult(async () => {
        const source = await analysis.inspect(assetId, {
          signals: getSignals(scope.signal, request?.signal),
        });
        return Object.freeze({
          ok: true as const,
          source: toSourceSnapshot(source),
        });
      });
    },
    readPcm: async (assetId, request) => {
      const missing = assertRequestPreconditions(
        assetId,
        scope.signal,
        request?.signal,
        () => assertReadRequest(request?.startSeconds, request?.endSeconds),
      );
      if (missing) return missing;
      return toAudioResult(async () => {
        const pcm = await analysis.readPcm(assetId, {
          startSeconds: request?.startSeconds,
          endSeconds: request?.endSeconds,
          maxFrames: MAX_PCM_FRAMES,
          signals: getSignals(scope.signal, request?.signal),
        });
        return Object.freeze({
          ok: true as const,
          source: toSourceSnapshot(pcm.source),
          startSeconds: pcm.startSeconds,
          durationSeconds: pcm.durationSeconds,
          channels: pcm.channels,
        });
      });
    },
    readWaveform: async (assetId, request) => {
      const samplesPerPeak =
        request?.samplesPerPeak ?? DEFAULT_SAMPLES_PER_PEAK;
      const missing = assertRequestPreconditions(
        assetId,
        scope.signal,
        request?.signal,
        () => {
          assertReadRequest(request?.startSeconds, request?.endSeconds);
          if (!Number.isInteger(samplesPerPeak) || samplesPerPeak <= 0) {
            throw new RangeError("samplesPerPeak must be a positive integer.");
          }
        },
      );
      if (missing) return missing;
      return toAudioResult(async () => {
        const waveform = await analysis.readWaveform(assetId, {
          startSeconds: request?.startSeconds,
          endSeconds: request?.endSeconds,
          samplesPerPeak,
          maxSourceFrames: MAX_WAVEFORM_SOURCE_FRAMES,
          maxPeaks: MAX_WAVEFORM_PEAKS,
          signals: getSignals(scope.signal, request?.signal),
        });
        return Object.freeze({
          ok: true as const,
          source: toSourceSnapshot(waveform.source),
          startSeconds: waveform.startSeconds,
          durationSeconds: waveform.durationSeconds,
          samplesPerPeak: waveform.samplesPerPeak,
          channels: waveform.channels,
        });
      });
    },
  };
  return Object.freeze(api);
}
