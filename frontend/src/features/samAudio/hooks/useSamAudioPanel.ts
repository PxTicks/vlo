import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { getRuntimeStatus } from "../../../services/runtimeApi";
import type { Asset } from "../../../types/Asset";
import type { MaskTimelineClip, TimelineClip } from "../../../types/TimelineTypes";
import {
  parseMaskClipId,
  selectMaskClipsForParent,
  useTimelineStore,
} from "../../timeline";
import { useProjectStore } from "../../project";
import { useTimelineSelectionStore } from "../../timelineSelection";
import { ensureAssetFileLoaded, useAssetStore } from "../../userAssets";
import { registerSourceVideo } from "../../masks/services/sam2Api";
import { createSplitAudioClip } from "../model/createSplitAudioClip";
import {
  fetchStem,
  pollJob,
  registerSourceAudio,
  submitSeparationJob,
  type SamAudioJobStatus,
} from "../services/samAudioApi";
import { useSamAudioStore } from "../store/useSamAudioStore";
import {
  createSamAudioPromptPayload,
  createSpanAnchorsForClip,
} from "../utils/promptMapping";

const POLL_INTERVAL_MS = 1000;

const samAudioSourceRegistrationCache = new Map<string, Promise<string>>();
const sam2SourceRegistrationCache = new Map<string, Promise<string>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function isAudioCapableClip(clip: TimelineClip | null): clip is TimelineClip & {
  assetId: string;
} {
  return clip?.type === "audio" || clip?.type === "video";
}

async function resolveAssetFile(asset: Asset): Promise<File> {
  if (asset.file) return asset.file;
  const hydratedFile = await ensureAssetFileLoaded(asset.id);
  if (hydratedFile) return hydratedFile;

  const response = await fetch(asset.src);
  if (!response.ok) {
    throw new Error(`Failed to fetch source asset file (${response.status})`);
  }
  const blob = await response.blob();
  return new File([blob], asset.name, {
    type: blob.type || (asset.type === "audio" ? "audio/wav" : "video/mp4"),
    lastModified: Date.now(),
  });
}

async function getOrRegisterSamAudioSource(asset: Asset): Promise<string> {
  const cached = samAudioSourceRegistrationCache.get(asset.hash);
  if (cached) return cached;
  const promise = resolveAssetFile(asset)
    .then((file) => registerSourceAudio(file, asset.hash))
    .then((registration) => registration.sourceId)
    .catch((error) => {
      samAudioSourceRegistrationCache.delete(asset.hash);
      throw error;
    });
  samAudioSourceRegistrationCache.set(asset.hash, promise);
  return promise;
}

async function getOrRegisterSam2Source(asset: Asset): Promise<string> {
  const cached = sam2SourceRegistrationCache.get(asset.hash);
  if (cached) return cached;
  const promise = resolveAssetFile(asset)
    .then((file) => registerSourceVideo(file, asset.hash))
    .then((registration) => registration.sourceId)
    .catch((error) => {
      sam2SourceRegistrationCache.delete(asset.hash);
      throw error;
    });
  sam2SourceRegistrationCache.set(asset.hash, promise);
  return promise;
}

function pickGeneratedSam2Mask(
  masks: MaskTimelineClip[],
): { mask: MaskTimelineClip; maskId: string } | null {
  for (const mask of masks) {
    if (mask.maskType !== "sam2" || !mask.sam2MaskAssetId) continue;
    const parsed = parseMaskClipId(mask.id);
    const maskId = parsed?.maskId;
    if (maskId) {
      return { mask, maskId };
    }
  }
  return null;
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

export function useSamAudioPanel() {
  const selectedClipId = useTimelineStore((state) => state.selectedClipIds[0] ?? null);
  const selectedClip = useTimelineStore((state) => {
    const id = state.selectedClipIds[0];
    return id ? (state.clips.find((clip) => clip.id === id) ?? null) : null;
  });
  const selectedMasks = useTimelineStore(
    useShallow((state) =>
      selectedClipId ? selectMaskClipsForParent(state, selectedClipId) : [],
    ),
  );
  const timelinePresentationData = useTimelineStore(
    useShallow((state) => ({
      tracks: state.tracks,
      clips: state.clips,
    })),
  );
  const spanSelection = useTimelineSelectionStore(
    useShallow((state) => ({
      selectionMode: state.selectionMode,
      selectionStartTick: state.selectionStartTick,
      selectionEndTick: state.selectionEndTick,
    })),
  );
  const assets = useAssetStore((state) => state.assets);
  const addLocalAsset = useAssetStore((state) => state.addLocalAsset);
  const projectFps = useProjectStore((state) => state.config.fps);
  const [availability, setAvailability] = useState<
    "idle" | "checking" | "available" | "unavailable"
  >("idle");
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const runIdRef = useRef(0);

  const {
    promptText,
    useSpanPrompt,
    useVisualPrompt,
    activeJobId,
    jobStatus,
    error,
    setPromptText,
    setUseSpanPrompt,
    setUseVisualPrompt,
    setActiveJob,
    setJobStatus,
    setError,
    resetJob,
  } = useSamAudioStore();

  const selectedAsset = useMemo(() => {
    if (!selectedClip || !isAudioCapableClip(selectedClip)) return null;
    return assets.find((asset) => asset.id === selectedClip.assetId) ?? null;
  }, [assets, selectedClip]);

  const generatedSam2Mask = useMemo(
    () => pickGeneratedSam2Mask(selectedMasks),
    [selectedMasks],
  );

  const spanAnchors = useMemo(() => {
    if (!selectedClip) return undefined;
    return createSpanAnchorsForClip(
      selectedClip,
      {
        tracks: timelinePresentationData.tracks,
        clips: timelinePresentationData.clips,
        fps: projectFps,
      },
      spanSelection,
    );
  }, [
    projectFps,
    selectedClip,
    spanSelection,
    timelinePresentationData.clips,
    timelinePresentationData.tracks,
  ]);
  const canUseSpanPrompt = spanAnchors !== undefined;
  const isBusy =
    jobStatus?.status === "queued" ||
    jobStatus?.status === "running" ||
    (activeJobId !== null && jobStatus?.status !== "done" && jobStatus?.status !== "error");

  const ensureSamAudioAvailable = useCallback(async (): Promise<boolean> => {
    setAvailability("checking");
    setAvailabilityError(null);
    try {
      const status = await getRuntimeStatus();
      if (status.sam_audio?.status === "available") {
        setAvailability("available");
        return true;
      }
      setAvailability("unavailable");
      setAvailabilityError(
        status.sam_audio?.error ?? "SAM-Audio is unavailable.",
      );
      return false;
    } catch (availabilityCheckError) {
      setAvailability("unavailable");
      setAvailabilityError(
        availabilityCheckError instanceof Error
          ? availabilityCheckError.message
          : "Unable to check SAM-Audio availability.",
      );
      return false;
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void ensureSamAudioAvailable();
  }, [ensureSamAudioAvailable]);

  const insertSplitClip = useCallback(
    (args: {
      sourceClip: TimelineClip;
      targetAsset: Asset;
      residualAsset: Asset;
      durationTicks: number;
    }) => {
      const timeline = useTimelineStore.getState();
      const sourceTrackIndex = timeline.tracks.findIndex(
        (track) => track.id === args.sourceClip.trackId,
      );
      const trackId = timeline.insertTrack(
        sourceTrackIndex >= 0 ? sourceTrackIndex + 1 : timeline.tracks.length,
        "audio",
      );
      const splitClip = createSplitAudioClip({
        sourceClip: args.sourceClip,
        targetAsset: args.targetAsset,
        residualAsset: args.residualAsset,
        durationTicks: args.durationTicks,
        fps: projectFps,
        trackId,
      });
      timeline.addClip(splitClip);
      timeline.selectClip(splitClip.id);
      return splitClip;
    },
    [projectFps],
  );

  const startSeparation = useCallback(async () => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setError(null);
    resetJob();

    try {
      if (!(await ensureSamAudioAvailable())) return;
      if (!selectedClip || !isAudioCapableClip(selectedClip) || !selectedAsset) {
        throw new Error("Select an audio or video clip with audio first.");
      }

      const presentationContext = {
        tracks: useTimelineStore.getState().tracks,
        clips: useTimelineStore.getState().clips,
        fps: projectFps,
      };
      const anchors = createSpanAnchorsForClip(
        selectedClip,
        presentationContext,
        spanSelection,
      );
      const hasText = promptText.trim().length > 0;
      const hasSpan = useSpanPrompt && anchors !== undefined;
      const hasVisual = useVisualPrompt && generatedSam2Mask !== null;
      if (useSpanPrompt && anchors === undefined) {
        throw new Error(
          "Select a timeline range that overlaps the selected clip first.",
        );
      }
      if (!hasText && !hasSpan && !hasVisual) {
        throw new Error("Add a text, span, or visual prompt first.");
      }

      const sourceId = await getOrRegisterSamAudioSource(selectedAsset);
      let visualPrompt: { sam2SourceId: string; sam2MaskId: string } | null = null;
      if (hasVisual && generatedSam2Mask) {
        if (selectedAsset.type !== "video") {
          throw new Error("Visual prompts require a video source clip.");
        }
        visualPrompt = {
          sam2SourceId: await getOrRegisterSam2Source(selectedAsset),
          sam2MaskId: generatedSam2Mask.maskId,
        };
      }

      const prompt = createSamAudioPromptPayload({
        text: promptText,
        anchors,
        useSpanPrompt,
        visualPrompt,
        useVisualPrompt,
      });
      const durationTicks = Math.max(
        1,
        Math.round(selectedClip.croppedSourceDuration || selectedClip.timelineDuration),
      );
      const { jobId } = await submitSeparationJob({
        sourceId,
        startTicks: Math.max(0, Math.round(selectedClip.offset || 0)),
        durationTicks,
        prompt,
      });
      setActiveJob(jobId);

      let status: SamAudioJobStatus;
      do {
        await sleep(POLL_INTERVAL_MS);
        if (runIdRef.current !== runId) return;
        status = await pollJob(jobId);
        setJobStatus(status);
      } while (status.status === "queued" || status.status === "running");

      if (status.status === "error") {
        throw new Error(status.error ?? "SAM-Audio separation failed.");
      }

      const [target, residual] = await Promise.all([
        fetchStem(jobId, "target"),
        fetchStem(jobId, "residual"),
      ]);
      if (runIdRef.current !== runId) return;

      const targetAsset = await addLocalAsset(
        buildStemFile(target.blob, selectedAsset, "target"),
        {
          source: "sam_audio",
          stem: "target",
          sourceAssetId: selectedAsset.id,
          sourceClipId: selectedClip.id,
          jobId,
          startTicks: Math.max(0, Math.round(selectedClip.offset || 0)),
          durationTicks: target.durationTicks || durationTicks,
        },
        undefined,
        { allowDuplicateHash: true },
      );
      const residualAsset = await addLocalAsset(
        buildStemFile(residual.blob, selectedAsset, "residual"),
        {
          source: "sam_audio",
          stem: "residual",
          sourceAssetId: selectedAsset.id,
          sourceClipId: selectedClip.id,
          jobId,
          startTicks: Math.max(0, Math.round(selectedClip.offset || 0)),
          durationTicks: residual.durationTicks || durationTicks,
        },
        undefined,
        { allowDuplicateHash: true },
      );
      if (!targetAsset || !residualAsset) {
        throw new Error("Failed to register SAM-Audio stems as assets.");
      }

      insertSplitClip({
        sourceClip: selectedClip,
        targetAsset,
        residualAsset,
        durationTicks: target.durationTicks || durationTicks,
      });
    } catch (separationError) {
      setError(
        separationError instanceof Error
          ? separationError.message
          : "SAM-Audio separation failed.",
      );
    }
  }, [
    addLocalAsset,
    ensureSamAudioAvailable,
    generatedSam2Mask,
    insertSplitClip,
    projectFps,
    promptText,
    resetJob,
    selectedAsset,
    selectedClip,
    setActiveJob,
    setError,
    setJobStatus,
    spanSelection,
    useSpanPrompt,
    useVisualPrompt,
  ]);

  return {
    selectedClip,
    selectedAsset,
    generatedSam2Mask,
    canUseSpanPrompt,
    spanPromptNeedsSelection: selectedClip !== null && useSpanPrompt && !canUseSpanPrompt,
    availability,
    availabilityError,
    promptText,
    useSpanPrompt,
    useVisualPrompt,
    activeJobId,
    jobStatus,
    error,
    isBusy,
    progress: jobStatus?.progress ?? 0,
    setPromptText,
    setUseSpanPrompt,
    setUseVisualPrompt,
    startSeparation,
    refreshAvailability: ensureSamAudioAvailable,
  };
}
