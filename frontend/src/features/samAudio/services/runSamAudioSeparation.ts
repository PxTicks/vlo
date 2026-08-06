import type { Asset } from "../../../types/Asset";
import type { TimelineClip } from "../../../types/TimelineTypes";
import {
  audioAnalysisService,
  isAudioAnalysisAbortError,
  type AudioAnalysisReader,
  type AudioAnalysisSource,
} from "../../userAssets";
import {
  addTimelineClipsOnNewTracksBelow,
  getTimelineClipById,
  getTimelinePresentationContext,
} from "../../timeline/api";
import { mediaSecondsToTick, ticksPerFrame } from "../../../core/time";
import { ensureAssetFileLoaded } from "../../userAssets/api";
import { useAssetStore } from "../../userAssets/useAssetStore";
import { createSplitAudioStemClip } from "../model/createSplitAudioClip";
import {
  fetchStem,
  registerSourceAudio,
  submitSeparationJob,
  type SamAudioJobStatus,
  waitForSeparationJob,
} from "./samAudioApi";
import {
  createSamAudioPromptPayload,
  createSpanAnchorsForClip,
  type SamAudioSpanSelection,
} from "../utils/promptMapping";
import { muteSourceClipAudio } from "./extractionTimelinePlacement";

const POLL_INTERVAL_MS = 1000;

const samAudioSourceRegistrationCache = new Map<string, Promise<string>>();

export interface SamAudioOperationProgress {
  message: string;
  progress: number;
}

export interface SamAudioRangePrompt {
  startTick: number;
  endTick: number;
}

export interface RunSamAudioSeparationArgs {
  clipId: string;
  textPrompt?: string;
  spanSelection?: SamAudioRangePrompt | null;
  signal?: AbortSignal;
  onProgress?: (progress: SamAudioOperationProgress) => void;
  onJobStatus?: (status: SamAudioJobStatus) => void;
}

export interface RunSamAudioSeparationResult {
  jobId: string;
  targetClipId: string;
  residualClipId: string;
}

export interface RunSamAudioSeparationDependencies {
  readonly analysis?: AudioAnalysisReader;
}

function createAbortError(): Error {
  const error = new Error("SAM-Audio operation cancelled");
  error.name = "AbortError";
  return error;
}

export function isSamAudioAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function isAudioCapableClip(clip: TimelineClip | null): clip is TimelineClip & {
  assetId: string;
} {
  return clip?.type === "audio" || clip?.type === "video";
}

async function resolveAssetFile(
  asset: Asset,
  options?: { signal?: AbortSignal },
): Promise<File> {
  throwIfAborted(options?.signal);
  if (asset.file) return asset.file;
  const hydratedFile = await ensureAssetFileLoaded(asset.id);
  throwIfAborted(options?.signal);
  if (hydratedFile) return hydratedFile;

  const response = await fetch(asset.src, { signal: options?.signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch source asset file (${response.status})`);
  }
  const blob = await response.blob();
  throwIfAborted(options?.signal);
  return new File([blob], asset.name, {
    type: blob.type || (asset.type === "audio" ? "audio/wav" : "video/mp4"),
    lastModified: Date.now(),
  });
}

async function getOrRegisterSamAudioSource(
  asset: Asset,
  options?: { signal?: AbortSignal },
): Promise<string> {
  const cached = samAudioSourceRegistrationCache.get(asset.hash);
  if (cached) return cached;
  const promise = resolveAssetFile(asset, options)
    .then((file) => registerSourceAudio(file, asset.hash, options))
    .then((registration) => registration.sourceId)
    .catch((error) => {
      samAudioSourceRegistrationCache.delete(asset.hash);
      throw error;
    });
  samAudioSourceRegistrationCache.set(asset.hash, promise);
  return promise;
}

async function inspectSamAudioSource(
  analysis: AudioAnalysisReader,
  assetId: string,
  signal?: AbortSignal,
): Promise<AudioAnalysisSource | null> {
  try {
    return await analysis.inspect(assetId, {
      signals: signal ? [signal] : [],
    });
  } catch (error) {
    if (isAudioAnalysisAbortError(error)) throw error;
    // The backend remains the final codec authority. Local inspection only
    // contributes a safer source window when the browser decoder supports it.
    return null;
  }
}

function buildStemFile(
  blob: Blob,
  sourceAsset: Asset,
  stem: "target" | "residual",
): File {
  return new File(
    [blob],
    `${sourceAsset.name}_sam_audio_${stem}_${Date.now()}.wav`,
    {
      type: blob.type || "audio/wav",
      lastModified: Date.now(),
    },
  );
}

function toSpanSelection(
  range: SamAudioRangePrompt | null | undefined,
): SamAudioSpanSelection | undefined {
  if (!range) return undefined;
  return {
    selectionMode: true,
    selectionStartTick: range.startTick,
    selectionEndTick: range.endTick,
  };
}

function getClipAndAsset(clipId: string): {
  clip: TimelineClip & { assetId: string };
  asset: Asset;
} {
  const clip = getTimelineClipById(clipId) ?? null;
  if (!isAudioCapableClip(clip)) {
    throw new Error("Select an audio or video clip with audio first.");
  }

  const asset = useAssetStore
    .getState()
    .assets.find((candidate) => candidate.id === clip.assetId);
  if (!asset) {
    throw new Error("The selected clip's source asset is no longer available.");
  }

  return { clip, asset };
}

function insertSplitAudioClips(args: {
  sourceClip: TimelineClip;
  targetAsset: Asset;
  residualAsset: Asset;
  durationTicks: number;
}): string[] {
  return addTimelineClipsOnNewTracksBelow(
    args.sourceClip.trackId,
    [
      {
        trackLabel: "SAM-Audio Target",
        trackType: "audio",
        createClip: (trackId) =>
          createSplitAudioStemClip({
            sourceClip: args.sourceClip,
            asset: args.targetAsset,
            stem: "target",
            durationTicks: args.durationTicks,
            trackId,
          }),
      },
      {
        trackLabel: "SAM-Audio Residual",
        trackType: "audio",
        createClip: (trackId) =>
          createSplitAudioStemClip({
            sourceClip: args.sourceClip,
            asset: args.residualAsset,
            stem: "residual",
            durationTicks: args.durationTicks,
            trackId,
          }),
      },
    ],
  );
}

export async function runSamAudioSeparation(
  {
    clipId,
    textPrompt = "",
    spanSelection,
    signal,
    onProgress,
    onJobStatus,
  }: RunSamAudioSeparationArgs,
  dependencies: RunSamAudioSeparationDependencies = {},
): Promise<RunSamAudioSeparationResult> {
  const { clip, asset } = getClipAndAsset(clipId);
  const analysis = dependencies.analysis ?? audioAnalysisService;

  throwIfAborted(signal);
  onProgress?.({
    message: "Preparing prompt and source window",
    progress: 0.08,
  });

  const presentationContext = getTimelinePresentationContext();
  const anchors = createSpanAnchorsForClip(
    clip,
    presentationContext,
    toSpanSelection(spanSelection),
  );
  const hasText = textPrompt.trim().length > 0;
  const hasSpan = spanSelection !== null && spanSelection !== undefined;
  if (hasSpan && anchors === undefined) {
    throw new Error("Select a timeline range that overlaps the selected clip.");
  }
  if (!hasText && !anchors) {
    throw new Error("Add a text prompt or select a timeline range first.");
  }

  onProgress?.({
    message: "Registering source audio with SAM-Audio",
    progress: 0.14,
  });
  const [sourceId, inspectedSource] = await Promise.all([
    getOrRegisterSamAudioSource(asset, { signal }),
    inspectSamAudioSource(analysis, asset.id, signal),
  ]);
  throwIfAborted(signal);

  let durationTicks = Math.max(
    1,
    Math.round(clip.croppedSourceDuration || clip.timelineDuration),
  );
  const startTicks = Math.max(0, Math.round(clip.offset || 0));
  if (inspectedSource) {
    const sourceExtentTicks = Math.max(
      0,
      mediaSecondsToTick(inspectedSource.endTimestampSeconds),
    );
    const availableTicks = sourceExtentTicks - startTicks;
    const shortfallTicks = durationTicks - availableTicks;
    const frameToleranceTicks = Math.ceil(
      ticksPerFrame(presentationContext.fps),
    );
    if (availableTicks > 0 && shortfallTicks > frameToleranceTicks) {
      console.warn("SAM-Audio source window shortened after local inspection", {
        assetId: asset.id,
        requestedDurationTicks: durationTicks,
        availableDurationTicks: availableTicks,
        sourceExtentTicks,
      });
      durationTicks = availableTicks;
    }
  }
  const prompt = createSamAudioPromptPayload({
    text: textPrompt,
    anchors,
    useSpanPrompt: anchors !== undefined,
    visualPrompt: null,
    useVisualPrompt: false,
  });

  onProgress?.({
    message: "Submitting SAM-Audio separation job",
    progress: 0.24,
  });
  const { jobId } = await submitSeparationJob(
    {
      sourceId,
      startTicks,
      durationTicks,
      prompt,
    },
    { signal },
  );
  throwIfAborted(signal);
  onJobStatus?.({
    jobId,
    status: "queued",
    progress: 0,
    message: "Waiting for SAM-Audio worker",
    error: null,
    sourceId,
    startTicks,
    durationTicks,
  });

  const status = await waitForSeparationJob(jobId, {
    signal,
    pollIntervalMs: POLL_INTERVAL_MS,
    onProgress: onJobStatus,
  });

  if (status.status === "error") {
    throw new Error(status.error ?? "SAM-Audio separation failed.");
  }
  if (status.status === "cancelled") {
    throw createAbortError();
  }

  onProgress?.({
    message: "Downloading separated stems",
    progress: 0.86,
  });
  const [target, residual] = await Promise.all([
    fetchStem(jobId, "target", { signal }),
    fetchStem(jobId, "residual", { signal }),
  ]);
  throwIfAborted(signal);

  onProgress?.({
    message: "Registering separated stems as assets",
    progress: 0.94,
  });
  const addLocalAsset = useAssetStore.getState().addLocalAsset;
  const targetAsset = await addLocalAsset(
    buildStemFile(target.blob, asset, "target"),
    {
      source: "sam_audio",
      stem: "target",
      sourceAssetId: asset.id,
      sourceClipId: clip.id,
      jobId,
      startTicks,
      durationTicks: target.durationTicks || durationTicks,
    },
    undefined,
    { allowDuplicateHash: true },
  );
  const residualAsset = await addLocalAsset(
    buildStemFile(residual.blob, asset, "residual"),
    {
      source: "sam_audio",
      stem: "residual",
      sourceAssetId: asset.id,
      sourceClipId: clip.id,
      jobId,
      startTicks,
      durationTicks: residual.durationTicks || durationTicks,
    },
    undefined,
    { allowDuplicateHash: true },
  );
  if (!targetAsset || !residualAsset) {
    throw new Error("Failed to register SAM-Audio stems as assets.");
  }

  const [targetClipId, residualClipId] = insertSplitAudioClips({
    sourceClip: clip,
    targetAsset,
    residualAsset,
    durationTicks: target.durationTicks || durationTicks,
  });
  if (!targetClipId || !residualClipId) {
    throw new Error("Failed to add SAM-Audio stems to the timeline.");
  }
  muteSourceClipAudio(clip.id);

  onProgress?.({
    message: "Separated stems added below the source clip",
    progress: 1,
  });
  return {
    jobId,
    targetClipId,
    residualClipId,
  };
}
