import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getRuntimeStatus } from "../../../services/runtimeApi";
import type {
  ClipMaskMode,
  ClipMaskPoint,
  MaskTimelineClip,
  TimelineClip,
} from "../../../types/TimelineTypes";
import { isAssetBackedClip } from "../../../types/TimelineTypes";
import {
  TICKS_PER_SECOND,
  countSam2MaskAssetConsumers,
  useTimelineStore,
} from "../../timeline";
import { playbackClock } from "../../player/services/PlaybackClock";
import { useProjectStore } from "../../project/useProjectStore";
import {
  ensureAssetFileLoaded,
  useAssetStore,
} from "../../userAssets";
import { useMaskViewStore } from "../store/useMaskViewStore";
import { toClipInputTimeTicks } from "../utils/clipTime";
import {
  clearSam2EditorSession,
  generateMaskFrame,
  generateMaskVideo,
  initSam2EditorSession,
  registerSourceVideo,
  type Sam2SourceRegistration,
} from "../services/sam2Api";

const sam2SourceRegistrationCache = new Map<
  string,
  Promise<Sam2SourceRegistration>
>();

function hashSam2Points(points: ClipMaskPoint[]): string {
  let hash = 2166136261;
  for (const point of points) {
    const token = `${point.x.toFixed(6)}|${point.y.toFixed(6)}|${point.label}|${Math.round(point.timeTicks)};`;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function resolveAssetFile(
  asset: { id: string; file?: File; src: string; name: string },
): Promise<File> {
  if (asset.file) return asset.file;
  const hydratedFile = await ensureAssetFileLoaded(asset.id);
  if (hydratedFile) {
    return hydratedFile;
  }
  const response = await fetch(asset.src);
  if (!response.ok) {
    throw new Error(`Failed to fetch source asset file (${response.status})`);
  }
  const blob = await response.blob();
  return new File([blob], asset.name, {
    type: blob.type || "video/mp4",
    lastModified: Date.now(),
  });
}

async function getOrRegisterSam2Source(
  sourceHash: string,
  resolveFile: () => Promise<File>,
): Promise<Sam2SourceRegistration> {
  const cached = sam2SourceRegistrationCache.get(sourceHash);
  if (cached) return cached;

  const registrationPromise = resolveFile()
    .then((file) => registerSourceVideo(file, sourceHash))
    .then((registration) => {
      return registration;
    })
    .catch((error) => {
      sam2SourceRegistrationCache.delete(sourceHash);
      throw error;
    });
  sam2SourceRegistrationCache.set(sourceHash, registrationPromise);
  return registrationPromise;
}

function toSourceFrameIndex(
  timeTicks: number,
  fps: number,
  frameCount: number,
): number {
  return Math.max(
    0,
    Math.min(
      Math.max(0, frameCount - 1),
      Math.floor((Math.max(0, timeTicks) / TICKS_PER_SECOND) * Math.max(1, fps)),
    ),
  );
}

interface Sam2UpdateClipMask {
  (
    clipId: string,
    maskId: string,
    updates: {
      maskMode?: ClipMaskMode;
      maskPoints?: ClipMaskPoint[];
      sam2GrowAmount?: number;
      sam2MaskAssetId?: string;
      sam2GeneratedPointsHash?: string;
      sam2LastGeneratedAt?: number;
    },
  ): void;
}

interface UseSam2MaskPanelArgs {
  selectedClipId: string | null;
  selectedClip: TimelineClip | null;
  selectedMaskId: string | null;
  selectedMask: MaskTimelineClip | null;
  isMaskTabActive: boolean;
  updateClipMask: Sam2UpdateClipMask;
}

export interface UseSam2MaskPanelResult {
  sam2GrowAmount: number;
  setSam2GrowAmount: (amount: number) => void;
  sam2Points: ClipMaskPoint[];
  sam2CurrentFramePointsCount: number;
  isSam2EditorOpen: boolean;
  isSam2Available: boolean;
  isSam2Checking: boolean;
  sam2AvailabilityError: string | null;
  ensureSam2Available: () => Promise<boolean>;
  clearSam2Points: () => void;
  clearSam2CurrentFramePoints: () => void;
  generateSam2FramePreview: () => Promise<void>;
  isSam2FrameGenerating: boolean;
  sam2FramePreviewError: string | null;
  generateSam2Mask: () => Promise<void>;
  isSam2Generating: boolean;
  sam2GenerateError: string | null;
  isSam2Dirty: boolean;
  hasSam2MaskAsset: boolean;
}

export function useSam2MaskPanel({
  selectedClipId,
  selectedClip,
  selectedMaskId,
  selectedMask,
  isMaskTabActive,
  updateClipMask,
}: UseSam2MaskPanelArgs): UseSam2MaskPanelResult {
  const [isSam2Generating, setIsSam2Generating] = useState(false);
  const [sam2GenerateError, setSam2GenerateError] = useState<string | null>(
    null,
  );
  const [isSam2FrameGenerating, setIsSam2FrameGenerating] = useState(false);
  const [sam2FramePreviewError, setSam2FramePreviewError] = useState<
    string | null
  >(null);
  const [sam2AvailabilityStatus, setSam2AvailabilityStatus] = useState<
    "idle" | "checking" | "available" | "unavailable"
  >("idle");
  const [sam2AvailabilityError, setSam2AvailabilityError] = useState<
    string | null
  >(null);
  const activeSam2SessionRef = useRef<{
    sourceId: string;
    maskId: string;
    ticksPerSecond: number;
    visibleSourceStartTicks: number;
    visibleSourceDurationTicks: number;
  } | null>(null);
  const activeSam2SessionInitRef = useRef<{
    key: string;
    promise: Promise<void>;
  } | null>(null);
  const sam2PreviewRequestRef = useRef<{
    controller: AbortController | null;
    frameIndex: number | null;
    pointsHash: string | null;
    maskId: string | null;
  }>({
    controller: null,
    frameIndex: null,
    pointsHash: null,
    maskId: null,
  });
  const lastAppliedSam2PreviewRef = useRef<{
    frameIndex: number;
    pointsHash: string;
    maskId: string;
  } | null>(null);
  const activePreviewMaskRef = useRef<{
    clipId: string;
    maskId: string;
  } | null>(null);

  const assets = useAssetStore((state) => state.assets);
  const addLocalAsset = useAssetStore((state) => state.addLocalAsset);
  const deleteAsset = useAssetStore((state) => state.deleteAsset);
  const sam2EditorMaskId = useMaskViewStore((state) =>
    selectedClipId
      ? (state.sam2EditorMaskByClipId[selectedClipId] ?? null)
      : null,
  );

  const sam2Points = useMemo(
    () => selectedMask?.maskPoints ?? [],
    [selectedMask],
  );
  const sam2PointsHash = useMemo(() => hashSam2Points(sam2Points), [sam2Points]);
  const projectFps = useProjectStore((state) => state.config.fps);
  const pointTimeEpsilonTicks = useMemo(() => {
    const safeFps =
      typeof projectFps === "number" &&
      Number.isFinite(projectFps) &&
      projectFps > 0
        ? projectFps
        : 30;
    return Math.max(1, TICKS_PER_SECOND / safeFps);
  }, [projectFps]);

  const [currentInputTimeTicks, setCurrentInputTimeTicks] = useState(0);

  useEffect(() => {
    if (!selectedMask || selectedMask.maskType !== "sam2") return;
    const update = (globalTimeTicks: number) => {
      const clampedGlobal = Math.max(
        selectedMask.start,
        Math.min(globalTimeTicks, selectedMask.start + selectedMask.timelineDuration),
      );
      const localVisualTicks = clampedGlobal - selectedMask.start;
      setCurrentInputTimeTicks(calculateClipInputTicks(selectedMask, localVisualTicks));
    };
    update(playbackClock.time);
    return playbackClock.subscribe(update);
  }, [selectedMask]);

  const sam2CurrentFramePointsCount = useMemo(
    () =>
      sam2Points.filter(
        (point) =>
          Math.abs(point.timeTicks - currentInputTimeTicks) <=
          pointTimeEpsilonTicks,
      ).length,
    [currentInputTimeTicks, pointTimeEpsilonTicks, sam2Points],
  );

  const isSam2EditorOpen =
    selectedMask?.maskType === "sam2" &&
    selectedMaskId !== null &&
    isMaskTabActive &&
    sam2EditorMaskId === selectedMaskId;
  const isSam2Selected = selectedMask?.maskType === "sam2";

  const ensureSam2Available = useCallback(async (): Promise<boolean> => {
    setSam2AvailabilityStatus((previous) =>
      previous === "available" ? "available" : "checking",
    );
    try {
      const runtimeStatus = await getRuntimeStatus();
      if (runtimeStatus.sam2.status === "available") {
        setSam2AvailabilityStatus("available");
        setSam2AvailabilityError(null);
        return true;
      }

      const message =
        runtimeStatus.sam2.error ??
        "SAM2 is unavailable. Install or configure SAM2 models first.";
      setSam2AvailabilityStatus("unavailable");
      setSam2AvailabilityError(message);
      return false;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to check SAM2 availability";
      setSam2AvailabilityStatus("unavailable");
      setSam2AvailabilityError(message);
      return false;
    }
  }, []);

  useEffect(() => {
    if (!isMaskTabActive || !isSam2Selected) return;
    void ensureSam2Available();
  }, [ensureSam2Available, isMaskTabActive, isSam2Selected]);

  const isSam2Dirty = useMemo(() => {
    if (!selectedMask || selectedMask.maskType !== "sam2") return false;
    if (sam2Points.length === 0) return false;
    if (!selectedMask.sam2MaskAssetId) return true;
    if (!selectedMask.sam2GeneratedPointsHash) return true;
    return selectedMask.sam2GeneratedPointsHash !== sam2PointsHash;
  }, [sam2Points.length, sam2PointsHash, selectedMask]);

  const cancelSam2PreviewRequest = useCallback(() => {
    const pending = sam2PreviewRequestRef.current.controller;
    if (pending) {
      pending.abort();
    }
    sam2PreviewRequestRef.current = {
      controller: null,
      frameIndex: null,
      pointsHash: null,
      maskId: null,
    };
  }, []);

  useEffect(() => {
    cancelSam2PreviewRequest();
    activeSam2SessionInitRef.current = null;
    lastAppliedSam2PreviewRef.current = null;
    setSam2GenerateError(null);
    setSam2FramePreviewError(null);
    if (selectedClipId) {
      useMaskViewStore.getState().clearSam2LivePreview(selectedClipId);
    }
  }, [cancelSam2PreviewRequest, selectedClipId, selectedMaskId]);

  const selectedClipIdRef = useRef(selectedClipId);
  selectedClipIdRef.current = selectedClipId;
  const selectedMaskIdRef = useRef(selectedMaskId);
  selectedMaskIdRef.current = selectedMaskId;

  useEffect(() => {
    return () => {
      cancelSam2PreviewRequest();
      activeSam2SessionInitRef.current = null;
      const existing = activeSam2SessionRef.current;
      if (!existing) return;
      activeSam2SessionRef.current = null;
      void clearSam2EditorSession(existing).catch(() => {
        // Best effort cleanup only.
      });
      const clipId = selectedClipIdRef.current;
      if (clipId) {
        useMaskViewStore.getState().clearSam2LivePreview(clipId);
      }
    };
  }, [cancelSam2PreviewRequest]);

  useEffect(() => {
    const existing = activeSam2SessionRef.current;
    if (
      existing &&
      (!selectedMaskId ||
        !isSam2EditorOpen ||
        existing.maskId !== selectedMaskId)
    ) {
      cancelSam2PreviewRequest();
      activeSam2SessionInitRef.current = null;
      lastAppliedSam2PreviewRef.current = null;
      activeSam2SessionRef.current = null;
      void clearSam2EditorSession(existing).catch(() => {
        // Best effort cleanup only.
      });
      if (selectedClipId) {
        useMaskViewStore.getState().clearSam2LivePreview(selectedClipId);
      }
    }
  }, [cancelSam2PreviewRequest, isSam2EditorOpen, selectedClipId, selectedMaskId]);

  useEffect(() => {
    const previousPreviewMask = activePreviewMaskRef.current;
    if (
      previousPreviewMask &&
      (!isMaskTabActive ||
        selectedClipId !== previousPreviewMask.clipId ||
        selectedMaskId !== previousPreviewMask.maskId)
    ) {
      updateClipMask(previousPreviewMask.clipId, previousPreviewMask.maskId, {
        maskMode: "apply",
      });
      useMaskViewStore
        .getState()
        .clearSam2LivePreview(previousPreviewMask.clipId);
    }

    if (
      isMaskTabActive &&
      selectedClipId &&
      selectedMaskId &&
      selectedMask?.maskType === "sam2" &&
      selectedMask.maskMode === "preview"
    ) {
      activePreviewMaskRef.current = {
        clipId: selectedClipId,
        maskId: selectedMaskId,
      };
      return;
    }

    activePreviewMaskRef.current = null;
  }, [isMaskTabActive, selectedClipId, selectedMaskId, selectedMask, updateClipMask]);

  const sam2GrowAmount =
    selectedMask?.maskType === "sam2" ? (selectedMask.sam2GrowAmount ?? 0) : 0;

  const setSam2GrowAmount = useCallback(
    (amount: number) => {
      if (!selectedClipId || !selectedMaskId) return;
      if (!selectedMask || selectedMask.maskType !== "sam2") return;

      const nextAmount = Number.isFinite(amount) ? Math.max(0, amount) : 0;
      updateClipMask(selectedClipId, selectedMaskId, {
        sam2GrowAmount: nextAmount,
      });
    },
    [selectedClipId, selectedMask, selectedMaskId, updateClipMask],
  );

  const clearSam2Points = useCallback(() => {
    if (!selectedClipId || !selectedMaskId) return;
    updateClipMask(selectedClipId, selectedMaskId, { maskPoints: [] });
  }, [selectedClipId, selectedMaskId, updateClipMask]);

  const clearSam2CurrentFramePoints = useCallback(() => {
    if (!selectedClipId || !selectedMaskId) return;
    const remaining = sam2Points.filter(
      (point) =>
        Math.abs(point.timeTicks - currentInputTimeTicks) > pointTimeEpsilonTicks,
    );
    updateClipMask(selectedClipId, selectedMaskId, { maskPoints: remaining });
  }, [
    currentInputTimeTicks,
    pointTimeEpsilonTicks,
    sam2Points,
    selectedClipId,
    selectedMaskId,
    updateClipMask,
  ]);

  const ensureSam2EditorSession = useCallback(async (): Promise<{
    sourceRegistration: Sam2SourceRegistration;
    parentClip: TimelineClip;
  } | null> => {
    if (!selectedMaskId) return null;
    if (!selectedMask || selectedMask.maskType !== "sam2") return null;

    const parentClip = selectedClip;
    if (!isAssetBackedClip(parentClip)) return null;

    const parentAsset = assets.find((asset) => asset.id === parentClip.assetId);
    if (!parentAsset) return null;

    const sourceRegistration = await getOrRegisterSam2Source(
      parentAsset.hash,
      () => resolveAssetFile(parentAsset),
    );
    const visibleSourceStartTicks = Math.max(0, parentClip.offset || 0);
    const visibleSourceDurationTicks = Math.max(
      0,
      parentClip.croppedSourceDuration || 0,
    );
    const desiredSession = {
      sourceId: sourceRegistration.sourceId,
      maskId: selectedMaskId,
      ticksPerSecond: TICKS_PER_SECOND,
      visibleSourceStartTicks,
      visibleSourceDurationTicks,
    };
    const desiredKey = `${desiredSession.sourceId}::${desiredSession.maskId}::${desiredSession.visibleSourceStartTicks}::${desiredSession.visibleSourceDurationTicks}::${desiredSession.ticksPerSecond}`;
    const activeSession = activeSam2SessionRef.current;
    if (
      activeSession &&
      activeSession.sourceId === desiredSession.sourceId &&
      activeSession.maskId === desiredSession.maskId &&
      activeSession.ticksPerSecond === desiredSession.ticksPerSecond &&
      activeSession.visibleSourceStartTicks ===
        desiredSession.visibleSourceStartTicks &&
      activeSession.visibleSourceDurationTicks ===
        desiredSession.visibleSourceDurationTicks
    ) {
      return {
        sourceRegistration,
        parentClip,
      };
    }

    const activeInit = activeSam2SessionInitRef.current;
    if (activeInit && activeInit.key === desiredKey) {
      await activeInit.promise;
      return {
        sourceRegistration,
        parentClip,
      };
    }

    const existingSession = activeSam2SessionRef.current;
    const shouldReplaceSession =
      !!existingSession &&
      (existingSession.sourceId !== desiredSession.sourceId ||
        existingSession.maskId !== desiredSession.maskId ||
        existingSession.ticksPerSecond !== desiredSession.ticksPerSecond ||
        existingSession.visibleSourceStartTicks !==
          desiredSession.visibleSourceStartTicks ||
        existingSession.visibleSourceDurationTicks !==
          desiredSession.visibleSourceDurationTicks);

    if (shouldReplaceSession && existingSession) {
      activeSam2SessionRef.current = null;
      await clearSam2EditorSession(existingSession).catch(() => {
        // Best effort cleanup only.
      });
    }

    const initPromise = initSam2EditorSession(desiredSession).then(() => {
      activeSam2SessionRef.current = desiredSession;
    });
    activeSam2SessionInitRef.current = {
      key: desiredKey,
      promise: initPromise,
    };
    try {
      await initPromise;
    } finally {
      if (activeSam2SessionInitRef.current?.key === desiredKey) {
        activeSam2SessionInitRef.current = null;
      }
    }

    return {
      sourceRegistration,
      parentClip,
    };
  }, [assets, selectedClip, selectedMask, selectedMaskId]);

  const applySam2FramePreview = useCallback(
    async (
      clipId: string,
      maskId: string,
      result: {
        blob: Blob;
        width: number;
        height: number;
        frameIndex: number;
        sourceFps: number;
      },
    ) => {
      const bitmap = await createImageBitmap(result.blob);
      if (
        selectedClipIdRef.current !== clipId ||
        selectedMaskIdRef.current !== maskId
      ) {
        bitmap.close();
        return;
      }

      useMaskViewStore
        .getState()
        .setSam2LivePreview(
          clipId,
          maskId,
          bitmap,
          result.width,
          result.height,
          result.frameIndex,
          result.sourceFps,
        );
    },
    [],
  );

  const fetchSam2FramePreview = useCallback(
    async (options?: {
      signal?: AbortSignal;
      globalTimeTicks?: number;
      includeCurrentFramePoints?: boolean;
    }): Promise<{
      blob: Blob;
      width: number;
      height: number;
      frameIndex: number;
      sourceFps: number;
      targetFrameIndex: number;
    } | null> => {
      if (sam2AvailabilityStatus === "unavailable") {
        return null;
      }
      if (sam2AvailabilityStatus !== "available") {
        const available = await ensureSam2Available();
        if (!available) return null;
      }
      if (!selectedClipId || !selectedMaskId) return null;
      if (!selectedMask || selectedMask.maskType !== "sam2") return null;

      const session = await ensureSam2EditorSession();
      if (!session) return null;
      const { sourceRegistration, parentClip } = session;

      const safeInputTimeTicks = toClipInputTimeTicks(
        parentClip,
        options?.globalTimeTicks ?? playbackClock.time,
      );
      const targetFrameIndex = toSourceFrameIndex(
        safeInputTimeTicks,
        sourceRegistration.fps,
        sourceRegistration.frameCount,
      );

      const shouldAddCurrentFramePoints =
        options?.includeCurrentFramePoints === true;
      let requestPoints: ClipMaskPoint[] = [];
      if (shouldAddCurrentFramePoints) {
        requestPoints = sam2Points.filter((point) => {
          const pointFrameIndex = toSourceFrameIndex(
            point.timeTicks,
            sourceRegistration.fps,
            sourceRegistration.frameCount,
          );
          return pointFrameIndex === targetFrameIndex;
        });
        if (requestPoints.length === 0) return null;
      }

      const generatedFrame = await generateMaskFrame(
        {
          sourceId: sourceRegistration.sourceId,
          points: requestPoints,
          ticksPerSecond: TICKS_PER_SECOND,
          timeTicks: safeInputTimeTicks,
          maskId: selectedMaskId,
        },
        { signal: options?.signal },
      );

      return {
        blob: generatedFrame.blob,
        width: generatedFrame.width,
        height: generatedFrame.height,
        frameIndex: generatedFrame.frameIndex,
        sourceFps: sourceRegistration.fps,
        targetFrameIndex,
      };
    },
    [
      ensureSam2Available,
      ensureSam2EditorSession,
      sam2AvailabilityStatus,
      sam2Points,
      selectedClipId,
      selectedMask,
      selectedMaskId,
    ],
  );

  useEffect(() => {
    if (!isSam2EditorOpen || !selectedClipId || !selectedMaskId) return;
    if (!selectedClip || selectedClip.type === "mask" || selectedClip.type === "audio") {
      return;
    }
    if (!selectedMask || selectedMask.maskType !== "sam2") return;

    if (selectedMask.maskMode !== "preview") {
      cancelSam2PreviewRequest();
      return;
    }

    let isDisposed = false;
    let isRunning = false;
    let queuedGlobalTimeTicks: number | null = null;

    const queuePreview = (
      globalTimeTicks: number,
      options?: { force?: boolean },
    ) => {
      if (isDisposed) return;

      const livePreview =
        useMaskViewStore.getState().sam2LivePreviewByClipId[selectedClipId];
      if (
        !options?.force &&
        livePreview &&
        livePreview.maskId === selectedMaskId &&
        livePreview.sourceFps > 0
      ) {
        const targetFrameIndex = toSourceFrameIndex(
          toClipInputTimeTicks(selectedClip, globalTimeTicks),
          livePreview.sourceFps,
          Number.MAX_SAFE_INTEGER,
        );
        const lastApplied = lastAppliedSam2PreviewRef.current;
        if (
          lastApplied &&
          lastApplied.maskId === selectedMaskId &&
          lastApplied.pointsHash === sam2PointsHash &&
          lastApplied.frameIndex === targetFrameIndex
        ) {
          return;
        }
      }

      queuedGlobalTimeTicks = globalTimeTicks;
      if (isRunning) return;
      isRunning = true;

      const processQueue = async () => {
        while (!isDisposed && queuedGlobalTimeTicks !== null) {
          const requestTimeTicks = queuedGlobalTimeTicks;
          queuedGlobalTimeTicks = null;

          const controller = new AbortController();
          cancelSam2PreviewRequest();
          sam2PreviewRequestRef.current = {
            controller,
            frameIndex: null,
            pointsHash: sam2PointsHash,
            maskId: selectedMaskId,
          };

          try {
            const result = await fetchSam2FramePreview({
              signal: controller.signal,
              globalTimeTicks: requestTimeTicks,
              includeCurrentFramePoints: false,
            });
            if (!result || controller.signal.aborted) {
              continue;
            }
            if (
              selectedClipIdRef.current !== selectedClipId ||
              selectedMaskIdRef.current !== selectedMaskId
            ) {
              continue;
            }

            await applySam2FramePreview(selectedClipId, selectedMaskId, result);
            setSam2FramePreviewError(null);
            lastAppliedSam2PreviewRef.current = {
              frameIndex: result.frameIndex,
              pointsHash: sam2PointsHash,
              maskId: selectedMaskId,
            };
          } catch (error) {
            if (controller.signal.aborted || isDisposed) {
              continue;
            }
            void error;
          } finally {
            const current = sam2PreviewRequestRef.current;
            if (current.controller === controller) {
              sam2PreviewRequestRef.current = {
                controller: null,
                frameIndex: null,
                pointsHash: null,
                maskId: null,
              };
            }
          }
        }

        isRunning = false;
      };

      void processQueue();
    };

    const unsubscribe = playbackClock.subscribe((timeTicks) => {
      queuePreview(timeTicks);
    });
    queuePreview(playbackClock.time, { force: true });

    return () => {
      isDisposed = true;
      unsubscribe();
      cancelSam2PreviewRequest();
    };
  }, [
    applySam2FramePreview,
    cancelSam2PreviewRequest,
    fetchSam2FramePreview,
    isSam2EditorOpen,
    sam2PointsHash,
    selectedClip,
    selectedClipId,
    selectedMask,
    selectedMaskId,
  ]);

  const generateSam2FramePreview = useCallback(async () => {
    if (!selectedClipId || !selectedMaskId) return;
    if (!(await ensureSam2Available())) {
      setSam2FramePreviewError(
        sam2AvailabilityError ??
          "SAM2 is unavailable. Install or configure SAM2 models first.",
      );
      return;
    }
    if (sam2Points.length === 0) {
      setSam2FramePreviewError("Add at least one SAM2 point before previewing.");
      return;
    }

    setIsSam2FrameGenerating(true);
    setSam2FramePreviewError(null);

    try {
      const result = await fetchSam2FramePreview({
        includeCurrentFramePoints: true,
      });
      if (!result) {
        setSam2FramePreviewError(
          "No SAM2 points at the current frame. Add points on this playhead frame first.",
        );
        return;
      }

      await applySam2FramePreview(selectedClipId, selectedMaskId, result);
      lastAppliedSam2PreviewRef.current = {
        frameIndex: result.frameIndex,
        pointsHash: sam2PointsHash,
        maskId: selectedMaskId,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "SAM2 single-frame preview failed";
      setSam2FramePreviewError(message);
    } finally {
      setIsSam2FrameGenerating(false);
    }
  }, [
    applySam2FramePreview,
    ensureSam2Available,
    fetchSam2FramePreview,
    sam2AvailabilityError,
    sam2Points.length,
    sam2PointsHash,
    selectedClipId,
    selectedMaskId,
  ]);

  const generateSam2Mask = useCallback(async () => {
    if (!selectedClipId || !selectedMaskId) return;
    if (!selectedMask || selectedMask.maskType !== "sam2") return;
    if (!(await ensureSam2Available())) {
      setSam2GenerateError(
        sam2AvailabilityError ??
          "SAM2 is unavailable. Install or configure SAM2 models first.",
      );
      return;
    }
    if (sam2Points.length === 0) {
      setSam2GenerateError("Add at least one SAM2 point before generating.");
      return;
    }

    const parentClip = selectedClip;
    if (!isAssetBackedClip(parentClip)) {
      setSam2GenerateError("Selected clip has no source asset.");
      return;
    }

    const parentAsset = assets.find((asset) => asset.id === parentClip.assetId);
    if (!parentAsset) {
      setSam2GenerateError("Parent asset was not found.");
      return;
    }

    setIsSam2Generating(true);
    setSam2GenerateError(null);

    const previousSam2AssetId = selectedMask.sam2MaskAssetId;
    const now = Date.now();
    try {
      const sourceHash = parentAsset.hash;
      const sourceRegistration = await getOrRegisterSam2Source(
        sourceHash,
        () => resolveAssetFile(parentAsset),
      );

      const visibleSourceStartTicks = Math.max(0, parentClip.offset || 0);
      const visibleSourceDurationTicks = Math.max(
        0,
        parentClip.croppedSourceDuration || 0,
      );

      const generated = await generateMaskVideo({
        sourceId: sourceRegistration.sourceId,
        points: sam2Points,
        ticksPerSecond: TICKS_PER_SECOND,
        maskId: selectedMaskId,
        visibleSourceStartTicks,
        visibleSourceDurationTicks,
      });

      const outputFile = new File(
        [generated.blob],
        `${parentAsset.name}_sam2_${selectedMaskId}_${now}.mp4`,
        {
          type: "video/mp4",
          lastModified: now,
        },
      );
      const maskClipId = `${selectedClipId}::mask::${selectedMaskId}`;
      const createdAsset = await addLocalAsset(outputFile, {
        source: "sam2_mask",
        parentAssetId: parentAsset.id,
        parentClipId: selectedClipId,
        maskClipId,
        pointCount: sam2Points.length,
        sourceHash,
      });

      if (!createdAsset) {
        throw new Error("Failed to create generated SAM2 mask asset.");
      }

      const pointsHash = hashSam2Points(sam2Points);
      updateClipMask(selectedClipId, selectedMaskId, {
        sam2MaskAssetId: createdAsset.id,
        sam2GeneratedPointsHash: pointsHash,
        sam2LastGeneratedAt: now,
      });

      useMaskViewStore.getState().clearSam2LivePreview(selectedClipId);

      if (previousSam2AssetId && previousSam2AssetId !== createdAsset.id) {
        try {
          const remainingConsumers = countSam2MaskAssetConsumers(
            useTimelineStore.getState().clips,
            previousSam2AssetId,
          );
          if (remainingConsumers === 0) {
            await deleteAsset(previousSam2AssetId);
          }
        } catch (error) {
          console.warn("Failed to delete previous SAM2 asset", error);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "SAM2 generation failed";
      setSam2GenerateError(message);
    } finally {
      setIsSam2Generating(false);
    }
  }, [
    addLocalAsset,
    assets,
    deleteAsset,
    ensureSam2Available,
    sam2AvailabilityError,
    sam2Points,
    selectedClip,
    selectedClipId,
    selectedMask,
    selectedMaskId,
    updateClipMask,
  ]);

  return {
    sam2GrowAmount,
    setSam2GrowAmount,
    sam2Points,
    sam2CurrentFramePointsCount,
    isSam2EditorOpen,
    isSam2Available: sam2AvailabilityStatus === "available",
    isSam2Checking: sam2AvailabilityStatus === "checking",
    sam2AvailabilityError,
    ensureSam2Available,
    clearSam2Points,
    clearSam2CurrentFramePoints,
    generateSam2FramePreview,
    isSam2FrameGenerating,
    sam2FramePreviewError,
    generateSam2Mask,
    isSam2Generating,
    sam2GenerateError,
    isSam2Dirty,
    hasSam2MaskAsset: !!selectedMask?.sam2MaskAssetId,
  };
}

function calculateClipInputTicks(
  clip: TimelineClip,
  localVisualTimeTicks: number,
): number {
  return toClipInputTimeTicks(clip, clip.start + localVisualTimeTicks);
}
