import type { Asset } from "../../../types/Asset";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { useProjectStore } from "../../project";
import { useTimelineStore } from "../../timeline";
import { ensureAssetFileLoaded, useAssetStore } from "../../userAssets";
import { createSplitAudioStemClip } from "../model/createSplitAudioClip";
import {
  fetchStem,
  pollJob,
  registerSourceAudio,
  submitSeparationJob,
  type SamAudioJobStatus,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
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
  const clip = useTimelineStore
    .getState()
    .clips.find((candidate) => candidate.id === clipId) ?? null;
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
  return useTimelineStore.getState().addClipsOnNewTracksBelow(
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

export async function runSamAudioSeparation({
  clipId,
  textPrompt = "",
  spanSelection,
  signal,
  onProgress,
  onJobStatus,
}: RunSamAudioSeparationArgs): Promise<RunSamAudioSeparationResult> {
  const { clip, asset } = getClipAndAsset(clipId);

  throwIfAborted(signal);
  onProgress?.({
    message: "Preparing prompt and source window",
    progress: 0.08,
  });

  const presentationContext = {
    tracks: useTimelineStore.getState().tracks,
    clips: useTimelineStore.getState().clips,
    fps: useProjectStore.getState().config.fps,
  };
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
  const sourceId = await getOrRegisterSamAudioSource(asset, { signal });
  throwIfAborted(signal);

  const durationTicks = Math.max(
    1,
    Math.round(clip.croppedSourceDuration || clip.timelineDuration),
  );
  const startTicks = Math.max(0, Math.round(clip.offset || 0));
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

  let status: SamAudioJobStatus;
  do {
    await sleep(POLL_INTERVAL_MS);
    throwIfAborted(signal);
    status = await pollJob(jobId);
    onJobStatus?.(status);
  } while (status.status === "queued" || status.status === "running");

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
