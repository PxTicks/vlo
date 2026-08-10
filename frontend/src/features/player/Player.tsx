import { useEffect, useRef, useMemo, memo, useCallback, useState } from "react";
import { Box } from "@mui/material";
import { RenderTexture } from "pixi.js";
import {
  AudioTrackLayer,
  getSharedDecoderWorkerPool,
  getProjectDimensions,
  getViewportContentTarget,
  renderProjectFrameFileAtTick,
  resolveCompositePreviewRasterDimensions,
  useExportJobController,
  useViewport,
  mediaSecondsToTickExact,
  LiveFrameGraphCoordinator,
  createCompositeSourcePolicySnapshot,
  isLiveFrameGraphEnabled,
  startFramePlanningDiagnosticsConsole,
  type CompositeAudioSourceData,
} from "../renderer";
import {
  useTimelineDuration,
  snapTickToFrameGrid,
} from "../timeline";
import {
  getTimelineModelState,
  useTimelineClips,
  useTimelineTracks,
  useTimelineTransitions,
} from "../timeline/api";
import { useProjectStore } from "../project";
import { audioSystem } from "./services/AudioSystem";
import { usePlayerStore } from "./usePlayerStore";
import { useExtractStore } from "../../core/extract/useExtractStore";
import { useHostContextMenu } from "../../core/shell/useHostContextMenu";
import { useCanvasSelectionStore } from "./useCanvasSelectionStore";
import { addLocalAsset, useAssetStore } from "../userAssets";
import { TrackLayer } from "./components/TrackLayer";
import {
  alignPlaybackTickToFrame,
  playbackClock,
  playbackFrameClock,
} from "../../core/playback/PlaybackClock";
import { installHostTransportController } from "../../core/playback/transportController";
import {
  isTransportAvailable,
  readTransportArbitrationState,
} from "./utils/transportArbitration";
import { usePixiApp } from "./hooks/usePixiApp";
import { useCanvasSelectionManager } from "./hooks/interaction/useCanvasSelectionManager";
import { useCanvasSelectionKeyboard } from "./hooks/interaction/useCanvasSelectionKeyboard";
import { useRenderGroupOrchestrator } from "./hooks/useRenderGroupOrchestrator";
import {
  clearCompositeDirectRenderError,
  getCompositeAssets,
  publishCompositeSourcePresentations,
  reportCompositeDirectRenderError,
  useCompositeLibraryStore,
  useCompositeRenderStatusStore,
} from "../composite";

import { PlayerControls } from "./components/PlayerControls";
import { ExtractDialog } from "./components/ExtractDialog";
import type { ExportFormatValue } from "./exportFormatsCatalogue";
import {
  createPointTimelineSelection,
  getDefaultSelectionEnd,
  useTimelineSelectionStore,
} from "../timelineSelection";
import {
  enqueueSynchronizedPlaybackQueueEntry,
  maxQueueSizeForMode,
  pruneSynchronizedPlaybackQueue,
  SYNCHRONIZED_SCRUB_SETTLE_DELAY_MS,
  type SynchronizedPlaybackQueueEntry,
} from "./utils/synchronizedPlaybackQueue";
import { CanvasToolBar } from "./components/CanvasToolBar";
import { useCanvasToolHost } from "./hooks/useCanvasToolHost";

type SynchronizedPlaybackRenderer = (time: number) => Promise<void>;

/**
 * How much chrome the preview carries
 * (docs/configurable-docking-and-dedicated-workspaces-plan.md §4.8).
 *
 * `compact` is the reuse seam for a task-focused stage: the same playback,
 * media, and frame services, minus the project-level chrome a focused workspace
 * has no business offering. It is deliberately a mode of this component rather
 * than a second preview, because a parallel player stack would mean a second
 * Pixi application, decoder pool lease, and audio graph.
 */
export type PlayerChrome = "full" | "compact";

export interface PlayerProps {
  readonly chrome?: PlayerChrome;
}

function PlayerImpl({ chrome = "full" }: PlayerProps) {
  const compact = chrome === "compact";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRootRef = useRef<HTMLDivElement>(null);
  const pendingFullscreenFitRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const setIsPlaying = usePlayerStore((state) => state.setIsPlaying);
  const togglePlay = usePlayerStore((state) => state.togglePlay);

  const lastSetTimeRef = useRef<number | null>(null);
  const synchronizedPlaybackRenderersRef = useRef(
    new Map<string, SynchronizedPlaybackRenderer>(),
  );
  const pendingPlaybackFrameQueueRef = useRef(
    [] as SynchronizedPlaybackQueueEntry[],
  );
  const synchronizedPlaybackBusyRef = useRef(false);
  // A retiring React effect hands queued work to the latest processor.
  const synchronizedPlaybackProcessorRef = useRef<(() => void) | null>(null);
  const activePlaybackRenderAbortRef = useRef<AbortController | null>(null);
  const temporalWarmupTargetRef = useRef<RenderTexture | null>(null);
  const maxTimelineDurationRef = useRef(0);

  // --- Store Data ---
  const tracks = useTimelineTracks();
  const clips = useTimelineClips();
  const transitions = useTimelineTransitions();
  const assets = useAssetStore((state) => state.assets);
  const composites = useCompositeLibraryStore((state) => state.composites);
  const timelineDuration = useTimelineDuration();
  const config = useProjectStore((state) => state.config);
  const forceLiveCompositeIds = useCompositeRenderStatusStore(
    (state) => state.forceLiveCompositeIds,
  );
  const forceBakedCompositeIds = useCompositeRenderStatusStore(
    (state) => state.forceBakedCompositeIds,
  );
  const compositeSourcePolicy = useMemo(
    () =>
      createCompositeSourcePolicySnapshot({
        forceLiveCompositeIds,
        forceBakedCompositeIds,
      }),
    [forceBakedCompositeIds, forceLiveCompositeIds],
  );

  const logicalDimensions = useMemo(
    () => getProjectDimensions(config.aspectRatio),
    [config.aspectRatio],
  );
  const compositeAudioSourceData = useMemo<CompositeAudioSourceData>(
    () => ({
      tracks,
      clips,
      composites,
      assets,
      projectFps: config.fps,
      logicalDimensions,
      sourcePolicy: compositeSourcePolicy,
    }),
    [
      assets,
      clips,
      compositeSourcePolicy,
      composites,
      config.fps,
      logicalDimensions,
      tracks,
    ],
  );
  const { cancel, runSelectionExport, runProjectExport } =
    useExportJobController({
      projectAspectRatio: config.aspectRatio,
      logicalDimensions,
      projectFps: config.fps,
    });

  // --- Pixi Initialization ---
  const { pixiApp, canvasSize } = usePixiApp(containerRef, canvasRef);
  useCanvasSelectionKeyboard();

  useEffect(() => {
    getSharedDecoderWorkerPool().warmUp();
  }, []);

  // --- Viewport Container ---
  // Declared up here (rather than later in the function) so the render-group
  // orchestrator can be parented to it and the playback loop can call into
  // the orchestrator's sync ref.
  const viewport = useViewport(pixiApp, {
    screenWidth: canvasSize.width,
    screenHeight: canvasSize.height,
    logicalWidth: logicalDimensions.width,
    logicalHeight: logicalDimensions.height,
  });
  const renderContent = getViewportContentTarget(viewport);
  const extensionCanvasSelectionHost = useMemo(
    () => ({
      captureTargetClipId: () =>
        useCanvasSelectionStore.getState().activeSelection?.clipId ?? null,
      clearSelection: () =>
        useCanvasSelectionStore.getState().clearSelection(),
    }),
    [],
  );
  const activeExtensionCanvasToolId = useCanvasToolHost(
    pixiApp,
    viewport,
    extensionCanvasSelectionHost,
  );
  const hostCanvasInteractionsEnabled = activeExtensionCanvasToolId === null;
  useCanvasSelectionManager(pixiApp, hostCanvasInteractionsEnabled);

  // Keep a ref to the latest currentTime to read inside the loop without restarting it
  const currentTimeRef = useRef(playbackClock.time);
  useEffect(() => {
    return playbackClock.subscribe((time) => {
      currentTimeRef.current = time;
    });
  }, []);

  // --- ORCHESTRATOR ---
  const visualTracks = useMemo(() => {
    return tracks.filter((t) => t.type === "visual" && t.isVisible);
  }, [tracks]);

  const tracksWithAudio = useMemo(() => {
    return tracks.filter(
      (t) =>
        (t.type === "audio" || t.type === "visual") &&
        t.isVisible &&
        !t.isMuted,
    );
  }, [tracks]);

  // Keep the playback loop stable across transform edits while still observing
  // the latest clip duration bounds for end-of-timeline detection.
  useEffect(() => {
    maxTimelineDurationRef.current = timelineDuration;
  }, [timelineDuration]);

  // Use a ref to access current isPlaying state inside useCallback without dependency
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);
  const visualTrackIds = useMemo(
    () => visualTracks.map((track) => track.id),
    [visualTracks],
  );
  const visualTrackIdsRef = useRef<string[]>(visualTrackIds);
  useEffect(() => {
    visualTrackIdsRef.current = visualTrackIds;
  }, [visualTrackIds]);

  // Render-group orchestrator. Owns Pixi parenting of track engine
  // containers and (in phase 3) time-bounded group containers under the
  // output-bearing content target. The sync ref fires per frame inside
  // processPendingPlaybackFrames below, between awaited per-track
  // renderers and pixiApp.render(). The hook also imperatively syncs on
  // `visualTrackIds` changes so paused edits to track order reflect
  // without waiting for the next clock tick.
  // Own the coordinator's lifecycle in an effect (not useMemo) so it is
  // StrictMode-safe: StrictMode mounts → cleanup (dispose) → remounts, and the
  // create-in-setup / dispose-in-cleanup shape yields a fresh live instance on
  // the second setup. A useMemo(…, []) would be disposed by the first cleanup
  // and never recreated, so every track's register() would no-op and nothing
  // would render. The instance lives in state so the fresh one propagates to
  // the child TrackLayers (which capture it as a prop).
  // Rollout flag (read once at mount). When off, the coordinator is never
  // created, so the gate below falls to the legacy per-engine path and tracks
  // register as synchronized renderers again — a clean rollback to pre-graph
  // live rendering without a rebuild.
  const liveFrameGraphEnabled = isLiveFrameGraphEnabled();
  const [liveFrameGraphCoordinator, setLiveFrameGraphCoordinator] =
    useState<LiveFrameGraphCoordinator | null>(null);
  const {
    orchestrator: renderGroupOrchestrator,
    adjustmentEffectResolver,
    syncRef: renderGroupSyncRef,
  } = useRenderGroupOrchestrator(
    renderContent,
    logicalDimensions,
    visualTrackIds,
    liveFrameGraphEnabled,
  );
  useEffect(() => {
    if (!liveFrameGraphEnabled || !pixiApp?.renderer) return;
    const coordinator = new LiveFrameGraphCoordinator({
      renderer: pixiApp.renderer,
      onCompositeSceneError: (error, job) => {
        reportCompositeDirectRenderError(job.activeClip.id, error);
      },
      onCompositeSceneRendered: (job, texture) => {
        clearCompositeDirectRenderError(job.activeClip.id);
        if (
          import.meta.env.VITE_E2E_DIAGNOSTICS === "true" &&
          window.__vloE2E?.acceptLiveCompositeFrame &&
          window.__vloE2E.requiresSourceFidelityCompositeFrame?.() === true &&
          job.compositeSource
        ) {
          try {
            const extracted = pixiApp.renderer.extract.pixels({
              target: texture,
            });
            window.__vloE2E.acceptLiveCompositeFrame({
              compositeId: job.compositeSource.compositeId,
              localPresentationTick:
                job.compositeSource.localPresentationTick,
              width: extracted.width,
              height: extracted.height,
              pixels: new Uint8ClampedArray(extracted.pixels),
            });
          } catch (error) {
            window.__vloE2E.rejectLiveCompositeFrame?.(String(error));
          }
        }
      },
    });
    // Own an external resource's lifecycle, not derived state — the setState
    // publishes the freshly created instance to children. One-time mount cost.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLiveFrameGraphCoordinator(coordinator);
    return () => {
      temporalWarmupTargetRef.current?.destroy(true);
      temporalWarmupTargetRef.current = null;
      coordinator.dispose();
      setLiveFrameGraphCoordinator((current) =>
        current === coordinator ? null : current,
      );
    };
  }, [liveFrameGraphEnabled, pixiApp]);
  useEffect(() => startFramePlanningDiagnosticsConsole(), []);
  useEffect(() => {
    liveFrameGraphCoordinator?.requestFrame(playbackClock.time);
  }, [
    config.fps,
    clips,
    composites,
    forceLiveCompositeIds,
    forceBakedCompositeIds,
    liveFrameGraphCoordinator,
    logicalDimensions,
    tracks,
    transitions,
    visualTrackIds,
  ]);

  const registerSynchronizedPlaybackRenderer = useCallback(
    (trackId: string, renderer: SynchronizedPlaybackRenderer | null) => {
      if (renderer) {
        synchronizedPlaybackRenderersRef.current.set(trackId, renderer);
        return;
      }
      synchronizedPlaybackRenderersRef.current.delete(trackId);
    },
    [],
  );

  const handleTogglePlay = useCallback(() => {
    const fps = useProjectStore.getState().config.fps;

    if (!isPlayingRef.current) {
      playbackFrameClock.setTime(
        alignPlaybackTickToFrame(playbackClock.time, fps),
      );
      audioSystem.resume();
    } else {
      // Pause pressed: Snap playhead to the *next* frame boundary
      const currentTime = playbackClock.time;
      const snappedTicks = snapTickToFrameGrid(currentTime, fps, "ceil");
      playbackFrameClock.setTime(snappedTicks);
      playbackClock.setTime(snappedTicks);
    }
    togglePlay();
  }, [togglePlay]);

  // Transport authority for callers outside the player feature (today the
  // extension API). Play and pause run the same entry point as the transport
  // button, and seek runs the same clamp-and-snap as a ruler scrub, so a
  // programmatic transport move cannot reach a state a click cannot.
  useEffect(
    () =>
      installHostTransportController({
        canControl: () =>
          isTransportAvailable(readTransportArbitrationState()),
        play: () => {
          if (!isPlayingRef.current) handleTogglePlay();
        },
        pause: () => {
          if (isPlayingRef.current) handleTogglePlay();
        },
        seek: (timeTicks: number) => {
          const fps = useProjectStore.getState().config.fps;
          playbackClock.setTime(
            snapTickToFrameGrid(Math.max(0, timeTicks), fps),
          );
        },
      }),
    [handleTogglePlay],
  );

  // --- Playback Loop ---
  useEffect(() => {
    if (!isPlaying) {
      lastSetTimeRef.current = null;
      pendingPlaybackFrameQueueRef.current = [];
      playbackFrameClock.setTime(
        alignPlaybackTickToFrame(currentTimeRef.current, config.fps),
      );
      return;
    }

    // Initialize Audio System
    audioSystem.notifyPlay(currentTimeRef.current);
    audioSystem.resume();
    lastSetTimeRef.current = currentTimeRef.current;
    playbackFrameClock.setTime(
      alignPlaybackTickToFrame(currentTimeRef.current, config.fps),
    );

    let animationFrameId: number;

    const loop = () => {
      // Sync to Audio System Clock (Clock-Driven Playback)
      const audioTime = audioSystem.getCurrentPlaybackTicks();
      // Live video follows a shared presentation frame, while the playhead
      // keeps following the continuous audio clock.
      const alignedFrameTime = alignPlaybackTickToFrame(audioTime, config.fps);
      const storeTime = currentTimeRef.current;

      // Detect if the store time changed externally (User Seek)
      // We allow a small epsilon for floating point differences between what we set and what we read back.
      // 0.1 seconds is a reasonable buffer that allows for frame jitter but catches deliberate seeks.
      const isUserSeek =
        lastSetTimeRef.current !== null &&
        Math.abs(storeTime - lastSetTimeRef.current) >
          mediaSecondsToTickExact(0.1);

      if (isUserSeek) {
        // Detected a Seek or significant drift initiated by user
        // Resync Audio to Store
        audioSystem.notifyPlay(storeTime);
        lastSetTimeRef.current = storeTime;
        playbackFrameClock.setTime(
          alignPlaybackTickToFrame(storeTime, config.fps),
        );
        playbackClock.setTime(storeTime);
        // Continue loop
        animationFrameId = requestAnimationFrame(loop);
      } else {
        // Normal playback
        const maxDuration = maxTimelineDurationRef.current;

        if (audioTime >= maxDuration && maxDuration > 0) {
          playbackFrameClock.setTime(
            alignPlaybackTickToFrame(maxDuration, config.fps),
          );
          playbackClock.setTime(maxDuration);
          setIsPlaying(false);
          lastSetTimeRef.current = null;
        } else {
          playbackFrameClock.setTime(alignedFrameTime);
          playbackClock.setTime(audioTime);
          lastSetTimeRef.current = audioTime;
          animationFrameId = requestAnimationFrame(loop);
        }
      }
    };

    animationFrameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationFrameId);
  }, [config.fps, isPlaying, setIsPlaying]);

  useEffect(() => {
    const activeClock = isPlaying ? playbackFrameClock : playbackClock;
    let isDisposed = false;
    const temporalPreviewQuality = isPlaying ? "exact" : "approximate";
    let scrubSettleTimer: ReturnType<typeof setTimeout> | null = null;

    const processPendingPlaybackFrames = async () => {
      if (synchronizedPlaybackBusyRef.current || isDisposed) return;
      synchronizedPlaybackBusyRef.current = true;

      const shouldPauseTicker = !isPlaying && !!pixiApp;
      if (shouldPauseTicker) {
        pixiApp.ticker.stop();
      }

      try {
        while (!isDisposed) {
          pruneSynchronizedPlaybackQueue(
            pendingPlaybackFrameQueueRef.current,
            performance.now(),
            { maxQueueSize: maxQueueSizeForMode(isPlaying) },
          );

          const nextFrame = pendingPlaybackFrameQueueRef.current.shift();
          if (!nextFrame) {
            break;
          }

          let usedFrameGraph = false;
          let compositeSourceCommits = [] as Parameters<
            typeof publishCompositeSourcePresentations
          >[0];
          if (
            adjustmentEffectResolver &&
            liveFrameGraphCoordinator &&
            liveFrameGraphCoordinator.participantCount > 0
          ) {
            const timelineState = getTimelineModelState();
            const abortController = new AbortController();
            activePlaybackRenderAbortRef.current = abortController;
            let result: Awaited<
              ReturnType<LiveFrameGraphCoordinator["renderFrame"]>
            > = null;
            try {
              result = await liveFrameGraphCoordinator.renderFrame(
                nextFrame.time,
                {
                  tracks: timelineState.tracks,
                  clips: timelineState.clips,
                  transitions: timelineState.transitions,
                  composites: getCompositeAssets(),
                  compositeSourcePolicy,
                  fps: config.fps,
                  logicalDimensions,
                  outputDimensions:
                    import.meta.env.VITE_E2E_DIAGNOSTICS === "true" &&
                    window.__vloE2E?.requiresSourceFidelityCompositeFrame?.()
                      ? undefined
                      : resolveCompositePreviewRasterDimensions(
                          logicalDimensions,
                          {
                            width:
                              pixiApp?.renderer.width ??
                              logicalDimensions.width,
                            height:
                              pixiApp?.renderer.height ??
                              logicalDimensions.height,
                          },
                        ),
                  visualTrackOrder: visualTrackIdsRef.current,
                  adjustmentEffectResolver,
                  signal: abortController.signal,
                  temporalPreviewQuality:
                    nextFrame.temporalPreviewQuality ?? "exact",
                  submitWarmupFrame: (tick, plan, render) => {
                    if (!pixiApp?.renderer) return;
                    renderGroupOrchestrator?.syncPresentationPlan(
                      tick,
                      plan,
                      render,
                    );
                    const width = Math.max(1, pixiApp.renderer.width);
                    const height = Math.max(1, pixiApp.renderer.height);
                    let target = temporalWarmupTargetRef.current;
                    if (
                      !target ||
                      target.destroyed ||
                      target.width !== width ||
                      target.height !== height
                    ) {
                      target?.destroy(true);
                      target = RenderTexture.create({ width, height });
                      temporalWarmupTargetRef.current = target;
                    }
                    // Warm output-bearing content at project scale. Viewport
                    // pan/zoom is editor presentation and must not determine
                    // temporal shader/filter compilation scale.
                    pixiApp.renderer.render({
                      container: renderContent ?? pixiApp.stage,
                      target,
                      clear: true,
                    });
                  },
                },
              );
            } finally {
              if (
                activePlaybackRenderAbortRef.current === abortController
              ) {
                activePlaybackRenderAbortRef.current = null;
              }
            }
            if (abortController.signal.aborted) {
              continue;
            }
            if (result) {
              renderGroupOrchestrator?.syncPresentationPlan(
                nextFrame.time,
                result.presentationPlan,
                result.render,
              );
              usedFrameGraph = true;
              compositeSourceCommits = result.execution.compositeSourceCommits;
            }
          } else {
            const frameRenderers = visualTrackIdsRef.current
              .map((trackId) =>
                synchronizedPlaybackRenderersRef.current.get(trackId),
              )
              .filter(
                (renderer): renderer is SynchronizedPlaybackRenderer =>
                  typeof renderer === "function",
              );

            await Promise.allSettled(
              frameRenderers.map((renderer) => renderer(nextFrame.time)),
            );
          }

          if (isDisposed) {
            continue;
          }

          // Per-track engine update is now settled. Rewrite scene-graph
          // parenting (track engines into / out of group containers based on
          // which group is active at this tick) and apply group transforms
          // before submitting the frame to the GPU.
          if (!usedFrameGraph) {
            renderGroupSyncRef.current(nextFrame.time);
          }

          if (pixiApp && pixiApp.renderer) {
            pixiApp.render();
            publishCompositeSourcePresentations(compositeSourceCommits);
          }
        }
      } finally {
        if (shouldPauseTicker && !isDisposed) {
          pixiApp.ticker.start();
        }

        synchronizedPlaybackBusyRef.current = false;
        if (pendingPlaybackFrameQueueRef.current.length > 0) {
          synchronizedPlaybackProcessorRef.current?.();
        }
      }
    };

    synchronizedPlaybackProcessorRef.current = processPendingPlaybackFrames;

    const enqueueFrame = (time: number) => {
      enqueueSynchronizedPlaybackQueueEntry(
        pendingPlaybackFrameQueueRef.current,
        {
          time,
          enqueuedAtMs: performance.now(),
          temporalPreviewQuality,
        },
        { maxQueueSize: maxQueueSizeForMode(isPlaying) },
      );
      void processPendingPlaybackFrames();

      if (isPlaying) return;
      if (scrubSettleTimer !== null) clearTimeout(scrubSettleTimer);
      scrubSettleTimer = setTimeout(() => {
        scrubSettleTimer = null;
        pendingPlaybackFrameQueueRef.current.length = 0;
        enqueueSynchronizedPlaybackQueueEntry(
          pendingPlaybackFrameQueueRef.current,
          {
            time,
            enqueuedAtMs: performance.now(),
            temporalPreviewQuality: "exact",
          },
          { maxQueueSize: maxQueueSizeForMode(false) },
        );
        void processPendingPlaybackFrames();
      }, SYNCHRONIZED_SCRUB_SETTLE_DELAY_MS);
    };

    pendingPlaybackFrameQueueRef.current = [];
    enqueueFrame(activeClock.time);

    const unsubscribe = activeClock.subscribe(enqueueFrame);
    const unsubscribeFrameRequests =
      liveFrameGraphCoordinator?.subscribeFrameRequests(enqueueFrame);

    return () => {
      isDisposed = true;
      if (
        synchronizedPlaybackProcessorRef.current ===
        processPendingPlaybackFrames
      ) {
        synchronizedPlaybackProcessorRef.current = null;
      }
      if (scrubSettleTimer !== null) clearTimeout(scrubSettleTimer);
      activePlaybackRenderAbortRef.current?.abort();
      activePlaybackRenderAbortRef.current = null;
      pendingPlaybackFrameQueueRef.current = [];
      unsubscribe();
      unsubscribeFrameRequests?.();
      if (!isPlaying && pixiApp) {
        pixiApp.ticker.start();
      }
    };
  }, [
    adjustmentEffectResolver,
    config.fps,
    isPlaying,
    liveFrameGraphCoordinator,
    logicalDimensions,
    compositeSourcePolicy,
    pixiApp,
    renderGroupOrchestrator,
    renderGroupSyncRef,
    renderContent,
  ]);

  // --- Extract / Export Logic ---
  const extractDialogOpen = useExtractStore((s) => s.dialogOpen);
  const extractDialogView = useExtractStore((s) => s.dialogView);
  const extractProgress = useExtractStore((s) => s.progress);
  const extractIsProcessing = useExtractStore((s) => s.isProcessing);
  const selectionMode = useTimelineSelectionStore((s) => s.selectionMode);
  const frameSelectionMode = useExtractStore((s) => s.frameSelectionMode);

  const performFrameExtraction = useCallback(async () => {
    const {
      setDialogView,
      setIsProcessing,
      closeDialog,
      exitFrameSelectionMode,
    } = useExtractStore.getState();

    exitFrameSelectionMode();
    useExtractStore.getState().openDialog();
    setDialogView("extracting-frame");
    setIsProcessing(true);

    try {
      const currentTime = playbackClock.time;
      const file = await renderProjectFrameFileAtTick(currentTime, {
        filenamePrefix: "frame",
        mimeType: "image/webp",
        quality: 0.95,
      });

      await addLocalAsset(file, {
        source: "extracted",
        timelineSelection: createPointTimelineSelection(currentTime),
      });
    } catch (e) {
      console.error("Frame extraction failed", e);
    } finally {
      closeDialog();
    }
  }, []);

  const handleExtractFrame = useCallback(() => {
    const { closeDialog, enterFrameSelectionMode, setOnConfirmSelection } =
      useExtractStore.getState();

    closeDialog();
    if (isPlaying) setIsPlaying(false);

    enterFrameSelectionMode();
    setOnConfirmSelection(performFrameExtraction);
  }, [isPlaying, setIsPlaying, performFrameExtraction]);

  const handleCancelProcessing = useCallback(() => {
    cancel();
    useExtractStore.getState().closeDialog();
  }, [cancel]);

  const handleConfirmSelection = useCallback(async () => {
    const {
      openDialog,
      setDialogView,
      setIsProcessing,
      setProgress,
      closeDialog,
    } = useExtractStore.getState();
    const {
      selectionStartTick,
      selectionEndTick,
      selectionMessage,
      selectionIncludedTrackIds,
      selectionFpsOverride,
      selectionFrameStep,
      exitSelectionMode,
    } = useTimelineSelectionStore.getState();

    exitSelectionMode();
    openDialog();
    setDialogView("extracting-selection");
    setIsProcessing(true);
    setProgress(0);

    try {
      await runSelectionExport({
        selectionStartTick,
        selectionEndTick,
        selectionMessage,
        selectionIncludedTrackIds,
        selectionFpsOverride,
        selectionFrameStep,
        onProgress: (progress) => {
          useExtractStore.getState().setProgress(progress);
        },
      });
    } finally {
      closeDialog();
    }
  }, [runSelectionExport]);

  const handleExtractSelection = useCallback(() => {
    const { closeDialog, setOnConfirmSelection } = useExtractStore.getState();
    const { enterSelectionMode } = useTimelineSelectionStore.getState();
    const currentTime = playbackClock.time;
    const safeEnd = getDefaultSelectionEnd(currentTime);

    closeDialog();
    // Pause playback when entering selection mode
    if (isPlaying) setIsPlaying(false);
    enterSelectionMode(currentTime, safeEnd);
    setOnConfirmSelection(handleConfirmSelection);
  }, [isPlaying, setIsPlaying, handleConfirmSelection]);

  const handleExport = useCallback(
    async (resolution: number, format: ExportFormatValue) => {
      const { setIsProcessing, setProgress, setDialogView, closeDialog } =
        useExtractStore.getState();

      let fileHandle: FileSystemFileHandle;
      try {
        fileHandle = (await useProjectStore.getState().project?.title)
          ? await import("../project").then((m) =>
              m.fileSystemService.showSaveVideoPicker(
                `${useProjectStore.getState().project?.title}.${format.extension}`,
                format.format,
              ),
            )
          : await import("../project").then((m) =>
              m.fileSystemService.showSaveVideoPicker(
                `export.${format.extension}`,
                format.format,
              ),
            );
      } catch (err) {
        // User cancelled the picker, abort silently.
        if ((err as DOMException).name === "AbortError") {
          return;
        }
        console.error("Failed to open save file picker", err);
        return;
      }

      setDialogView("export");
      setIsProcessing(true);
      setProgress(0);

      try {
        await runProjectExport({
          resolution,
          format: format.format,
          keyFrameInterval: format.keyFrameInterval,
          fileHandle,
          onProgress: (progress) => {
            useExtractStore.getState().setProgress(progress);
          },
        });
      } finally {
        closeDialog();
      }
    },
    [runProjectExport],
  );

  // --- Viewport Helpers ---
  const fitViewportToScreen = useCallback(() => {
    if (!viewport) return;

    viewport.moveCenter(
      logicalDimensions.width / 2,
      logicalDimensions.height / 2,
    );
    viewport.fit(true);
  }, [logicalDimensions.height, logicalDimensions.width, viewport]);

  const scheduleViewportFit = useCallback(() => {
    requestAnimationFrame(() => {
      fitViewportToScreen();
    });
  }, [fitViewportToScreen]);

  // Wave-2 canvas menu (plan §3.5, `player.canvas.context`). Right-click
  // stays owned by live canvas interactions where they claim it: with a mask
  // selected it places SAM2 negative points, and the selection/frame-capture
  // modes have their own pointer semantics — the menu opens only outside
  // those interactions.
  const showContextMenu = useHostContextMenu();
  const handleCanvasContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      const maskEditing =
        useCanvasSelectionStore.getState().activeSelection?.kind === "mask";
      if (
        !hostCanvasInteractionsEnabled ||
        maskEditing ||
        selectionMode ||
        frameSelectionMode
      ) {
        return;
      }
      showContextMenu({
        menuId: "player.canvas.context",
        subject: {
          slot: "player.canvas.context",
          player: {
            playing: isPlayingRef.current,
            fullscreen: isFullscreen,
          },
        },
        items: [
          {
            kind: "action",
            id: "toggle-play",
            label: isPlayingRef.current ? "Pause" : "Play",
            group: "1_playback",
            run: handleTogglePlay,
          },
          {
            kind: "action",
            id: "fit-view",
            label: "Fit to screen",
            group: "2_view",
            run: fitViewportToScreen,
          },
          {
            kind: "action",
            id: "export",
            label: "Export…",
            group: "3_export",
            run: () => useExtractStore.getState().openDialog(),
          },
        ],
        position: { x: event.clientX, y: event.clientY },
      });
    },
    [
      selectionMode,
      frameSelectionMode,
      hostCanvasInteractionsEnabled,
      isFullscreen,
      handleTogglePlay,
      fitViewportToScreen,
      showContextMenu,
    ],
  );

  const handleToggleFullscreen = useCallback(async () => {
    const playerRoot = playerRootRef.current;
    if (!playerRoot) return;

    try {
      if (document.fullscreenElement === playerRoot) {
        await document.exitFullscreen();
        return;
      }

      await playerRoot.requestFullscreen();
    } catch (error) {
      console.error("Failed to toggle fullscreen player", error);
    }
  }, []);

  useEffect(() => {
    const playerRoot = playerRootRef.current;
    if (!playerRoot) return;

    const handleFullscreenChange = () => {
      const isPlayerFullscreen = document.fullscreenElement === playerRoot;
      setIsFullscreen(isPlayerFullscreen);
      if (!isPlayerFullscreen && document.fullscreenElement) return;
      pendingFullscreenFitRef.current = true;
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!pendingFullscreenFitRef.current) return;
    if (canvasSize.width === 0 || canvasSize.height === 0) return;

    pendingFullscreenFitRef.current = false;
    scheduleViewportFit();
  }, [canvasSize.height, canvasSize.width, scheduleViewportFit]);

  // ... (Keep existing play loop hooks)

  return (
    <Box
      ref={playerRootRef}
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        bgcolor: "#000",
        "&:fullscreen": {
          width: "100vw",
          height: "100vh",
        },
      }}
    >
      <Box
        ref={containerRef}
        data-testid="player-canvas-container"
        onContextMenu={handleCanvasContextMenu}
        sx={{
          flexGrow: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          // Height Removed to let flexGrow manage it
          minHeight: 0, // Critical for nested flex
          overflow: "hidden",
          position: "relative", // Ensure container is positioning context
          bgcolor: "#0a0a0a",
          backgroundImage:
            "radial-gradient(#1a1a1a 1px, transparent 1px), radial-gradient(#1a1a1a 1px, transparent 1px)",
          backgroundSize: "20px 20px",
          backgroundPosition: "0 0, 10px 10px",
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            width: "100%",
            height: "100%",
          }}
        />
        {/* Render Track Layers */}
        {pixiApp &&
          viewport &&
          renderContent &&
          visualTracks.map((track, index) => (
            <TrackLayer
              key={track.id}
              trackId={track.id}
              app={pixiApp}
              container={renderContent}
              overlayContainer={viewport}
              zIndex={visualTracks.length - 1 - index}
              logicalDimensions={logicalDimensions}
              registerSynchronizedPlaybackRenderer={
                registerSynchronizedPlaybackRenderer
              }
              orchestrator={renderGroupOrchestrator}
              adjustmentEffectResolver={adjustmentEffectResolver}
              liveFrameGraphCoordinator={liveFrameGraphCoordinator}
              interactionsEnabled={hostCanvasInteractionsEnabled}
            />
          ))}
        <CanvasToolBar activeToolId={activeExtensionCanvasToolId} />
        {/* Render Audio Layers (Invisible) */}
        {tracksWithAudio.map((track) => (
          <AudioTrackLayer
            key={track.id}
            trackId={track.id}
            adjustmentEffectResolver={adjustmentEffectResolver}
            compositeSourceData={compositeAudioSourceData}
          />
        ))}
      </Box>

      <PlayerControls
        isPlaying={isPlaying}
        onTogglePlay={handleTogglePlay}
        onFitView={fitViewportToScreen}
        onToggleFullscreen={compact ? undefined : handleToggleFullscreen}
        isFullscreen={isFullscreen}
        onOpenExport={() => useExtractStore.getState().openDialog()}
        exportDisabled={selectionMode || frameSelectionMode}
        showExport={!compact}
      />

      {/* Export and extraction are project-level actions owned by the full
          editor; a compact preview borrows the picture, not the workflow. */}
      {compact ? null : (
        <ExtractDialog
          open={extractDialogOpen}
          dialogView={extractDialogView}
          onClose={() => useExtractStore.getState().closeDialog()}
          onCancelProcessing={handleCancelProcessing}
          onExtractFrame={handleExtractFrame}
          onExtractSelection={handleExtractSelection}
          onExport={handleExport}
          onSetView={(view) => useExtractStore.getState().setDialogView(view)}
          isProcessing={extractIsProcessing}
          progress={extractProgress}
        />
      )}
    </Box>
  );
}

export const Player = memo(PlayerImpl);
