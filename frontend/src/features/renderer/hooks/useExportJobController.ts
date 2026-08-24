import { useCallback, useEffect, useRef } from "react";
import { useExtractStore } from "../../../core/extract/useExtractStore";
import {
  installHostExportController,
  type HostExportRunRequest,
} from "../../../core/export/exportController";
import {
  beginExportRun,
  getActiveExportRun,
  type ExportRunHandle,
} from "../../../core/export/exportRunLog";
import {
  getTimelineClips,
  getTimelineDuration,
  getTimelineTracks,
  getTimelineTransitions,
} from "../../timeline/api";
import { addLocalAsset, getAssets } from "../../userAssets";
import { prepareBrushMasksForTimelineRender } from "../../masks/api";
import {
  getClipsInSelection,
  resolveSelectionFps,
} from "../../timelineSelection";
import {
  ExportRenderer,
  type ProjectData,
  type ExportConfig,
} from "../services/ExportRenderer";
import { renderSelectionToVideoFile } from "../services/renderSelectionToVideoFile";
import { acquireExportWakeLock } from "../services/exportWakeLock";
import { resolveRenderOutputDimensions } from "../utils/dimensions";
import type { AspectRatio } from "../../project/useProjectStore";
import type { OutputVideoFormat } from "../services/TextureOutputEncoder";
import {
  getCompositeAssets,
  getCompositeForceBakedIds,
  getCompositeForceLiveIds,
} from "../../composite";
import { createCompositeSourcePolicySnapshot } from "../services/framePlanning";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createAbortError(): Error {
  const error = new Error("Render cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * The registry carries the container as an open string — it is declared in a
 * catalogue the encoder does not own — so this hook, which does own the
 * encoder, is where it narrows.
 */
function narrowOutputFormat(format: string): OutputVideoFormat | null {
  return format === "mp4" || format === "webm" ? format : null;
}

type ExportWakeLock = ReturnType<typeof acquireExportWakeLock>;

/** How a render ended, carried back so the caller settles the run last. */
type ExportRunOutcome =
  | { status: "completed"; assetId: string | null }
  | { status: "cancelled" }
  | { status: "failed"; error: unknown };

/**
 * Settling notifies every subscriber, so it must be the *last* thing a render
 * does. An extension that starts its next render from the completion
 * notification would otherwise be refused `export_busy` by state the host had
 * not finished releasing, and nothing would signal again once it had.
 */
function settleExportRun(run: ExportRunHandle, outcome: ExportRunOutcome): void {
  if (outcome.status === "completed") {
    run.complete({ assetId: outcome.assetId });
  } else if (outcome.status === "cancelled") {
    run.cancel();
  } else {
    run.fail(outcome.error);
  }
}

export interface SelectionExportOptions {
  selectionStartTick: number;
  selectionEndTick: number;
  selectionMessage: string | null;
  selectionIncludedTrackIds: string[];
  selectionFpsOverride: number | null;
  /**
   * Short edge the selection asked for, or `null` to follow the project. The
   * same value the generation pipeline renders this selection at, so an
   * extracted file and a dispatched one are the same size.
   */
  selectionResolution?: number | null;
  selectionFrameStep: number;
  selectionFrameOffset?: number;
  onProgress?: (progress: number) => void;
  /** Output container; the renderer's own default when omitted. */
  format?: OutputVideoFormat;
  keyFrameInterval?: number;
}

export interface ProjectExportOptions {
  resolution: number;
  format?: OutputVideoFormat;
  keyFrameInterval?: number;
  fileHandle?: FileSystemFileHandle;
  onProgress?: (progress: number) => void;
}

export interface UseExportJobControllerOptions {
  projectAspectRatio: AspectRatio;
  /** Short edge in pixels; the project's own render resolution. */
  projectOutputResolution: number;
  logicalDimensions: { width: number; height: number };
  projectFps: number;
}

export interface ExportJobController {
  cancel: () => void;
  runSelectionExport: (options: SelectionExportOptions) => Promise<void>;
  runProjectExport: (options: ProjectExportOptions) => Promise<void>;
}

/**
 * Manages cancellable export/extraction jobs and guards against stale async cleanup
 * when users quickly cancel and start another render.
 */
export function useExportJobController({
  projectAspectRatio,
  projectOutputResolution,
  logicalDimensions,
  projectFps,
}: UseExportJobControllerOptions): ExportJobController {
  const activeRendererRef = useRef<ExportRenderer | null>(null);
  const cancelRenderRequestedRef = useRef(false);
  const renderSessionRef = useRef(0);

  const beginSession = useCallback(() => {
    const sessionId = renderSessionRef.current + 1;
    renderSessionRef.current = sessionId;
    cancelRenderRequestedRef.current = false;
    return sessionId;
  }, []);

  const registerRenderer = useCallback(
    (renderer: ExportRenderer, sessionId: number) => {
      if (sessionId !== renderSessionRef.current) {
        renderer.cancel();
        throw createAbortError();
      }

      activeRendererRef.current = renderer;
      if (cancelRenderRequestedRef.current) {
        renderer.cancel();
      }
    },
    [],
  );

  const finalizeSession = useCallback((sessionId: number) => {
    if (sessionId !== renderSessionRef.current) return;
    activeRendererRef.current = null;
    cancelRenderRequestedRef.current = false;
  }, []);

  const buildProjectData = useCallback((): ProjectData => {
    const assets = getAssets();
    const duration = getTimelineDuration();

    return {
      tracks: getTimelineTracks(),
      clips: getTimelineClips(),
      transitions: getTimelineTransitions(),
      composites: getCompositeAssets(),
      assets,
      duration,
      fps: projectFps,
      compositeSourcePolicy: createCompositeSourcePolicySnapshot({
        forceLiveCompositeIds: getCompositeForceLiveIds(),
        forceBakedCompositeIds: getCompositeForceBakedIds(),
      }),
    };
  }, [projectFps]);

  const cancel = useCallback(() => {
    cancelRenderRequestedRef.current = true;
    activeRendererRef.current?.cancel();
  }, []);

  useEffect(() => {
    return () => {
      cancel();
    };
  }, [cancel]);

  /**
   * The one range-render path. It reports progress on `run` but deliberately
   * does not settle it: settling notifies subscribers, and a subscriber told
   * "completed" must find a renderer that is actually free. The caller settles
   * only after its own teardown — see {@link settleExportRun}.
   *
   * `run` is passed in rather than opened here because a caller that started
   * the render (the extension registry) needs its ID before the first `await`,
   * and a run that only appeared once rendering began would be unobservable at
   * exactly the moment it matters.
   */
  const executeRangeExport = useCallback(
    async (
      {
        selectionStartTick,
        selectionEndTick,
        selectionMessage,
        selectionIncludedTrackIds,
        selectionFpsOverride,
        selectionResolution,
        selectionFrameStep,
        selectionFrameOffset,
        onProgress,
        format,
        keyFrameInterval,
      }: SelectionExportOptions,
      run: ExportRunHandle,
    ): Promise<ExportRunOutcome> => {
      const sessionId = beginSession();
      let wakeLock: ExportWakeLock | null = null;

      try {
        wakeLock = acquireExportWakeLock();
        const outputDimensions = resolveRenderOutputDimensions(
          projectAspectRatio,
          selectionResolution ?? projectOutputResolution,
        );

        const exportConfig: ExportConfig = {
          logicalWidth: logicalDimensions.width,
          logicalHeight: logicalDimensions.height,
          outputWidth: outputDimensions.width,
          outputHeight: outputDimensions.height,
          backgroundAlpha: 0,
        };

        await prepareBrushMasksForTimelineRender();
        const projectData = buildProjectData();
        const selectionFps = resolveSelectionFps(
          { fps: selectionFpsOverride },
          projectData.fps,
        );
        const selectionTimelineSelection = {
          start: selectionStartTick,
          end: selectionEndTick,
          clips: getClipsInSelection(projectData.clips, {
            start: selectionStartTick,
            end: selectionEndTick,
            clips: [],
          }),
          tracks: projectData.tracks,
          transitions: projectData.transitions,
          ...(selectionMessage ? { message: selectionMessage } : {}),
          ...(selectionIncludedTrackIds.length > 0
            ? { includedTrackIds: selectionIncludedTrackIds.slice() }
            : {}),
          fps: selectionFps,
          // Recorded alongside fps for the same reason: this selection is
          // stored as the extracted asset's creation metadata, and reopening
          // it must reproduce the render it came from rather than pick up
          // whatever the project resolution happens to be later.
          resolution: selectionResolution ?? projectOutputResolution,
          frameStep: selectionFrameStep,
          ...(selectionFrameOffset && selectionFrameOffset > 1
            ? { frameOffset: selectionFrameOffset }
            : {}),
        };

        const file = await renderSelectionToVideoFile(
          selectionTimelineSelection,
          {
            renderInputs: {
              exportConfig,
              projectData,
              brushMasksPrepared: true,
            },
            onProgress: (progress) => {
              run.reportProgress(progress);
              onProgress?.(progress);
            },
            ...(format ? { format } : {}),
            ...(keyFrameInterval !== undefined ? { keyFrameInterval } : {}),
            skipNormalize: true,
            filenamePrefix: "selection",
            onRendererCreated: (renderer) =>
              registerRenderer(renderer, sessionId),
          },
        );

        // `reuseExistingHash` matches what `api.assets.ingest` already does:
        // re-rendering identical bytes should answer with the asset that
        // holds them, not with nothing. Without it a repeat render skips the
        // upload and reports no asset at all, which contradicts what a range
        // render promises.
        const asset = await addLocalAsset(
          file,
          { source: "extracted", timelineSelection: selectionTimelineSelection },
          undefined,
          { reuseExistingHash: true },
        );
        if (!asset) {
          // The frames were produced but nothing holds them, so this is not a
          // completed range render however far the renderer got.
          throw new Error("The rendered file could not be added to the library.");
        }
        return { status: "completed", assetId: asset.id };
      } catch (e) {
        if (isAbortError(e)) return { status: "cancelled" };
        console.error("Selection extraction failed", e);
        return { status: "failed", error: e };
      } finally {
        wakeLock?.release();
        finalizeSession(sessionId);
      }
    },
    [
      beginSession,
      buildProjectData,
      finalizeSession,
      logicalDimensions,
      projectAspectRatio,
      projectOutputResolution,
      registerRenderer,
    ],
  );

  const runSelectionExport = useCallback(
    async (options: SelectionExportOptions) => {
      const run = beginExportRun({
        kind: "range",
        startTicks: options.selectionStartTick,
        endTicks: options.selectionEndTick,
      });
      settleExportRun(run, await executeRangeExport(options, run));
    },
    [executeRangeExport],
  );

  const runProjectExport = useCallback(
    async ({
      resolution,
      format,
      keyFrameInterval,
      fileHandle,
      onProgress,
    }: ProjectExportOptions) => {
      const sessionId = beginSession();
      let wakeLock: ExportWakeLock | null = null;
      const run = beginExportRun({
        kind: "project",
        startTicks: 0,
        endTicks: getTimelineDuration(),
        formatId: format ?? null,
      });
      let outcome: ExportRunOutcome;

      try {
        wakeLock = acquireExportWakeLock();
        const outputDimensions = resolveRenderOutputDimensions(
          projectAspectRatio,
          resolution,
        );

        const exportConfig: ExportConfig = {
          logicalWidth: logicalDimensions.width,
          logicalHeight: logicalDimensions.height,
          outputWidth: outputDimensions.width,
          outputHeight: outputDimensions.height,
          fileHandle,
        };

        await prepareBrushMasksForTimelineRender();
        const projectData = buildProjectData();
        const fullTimelineSelection = {
          start: 0,
          end: projectData.duration,
          clips: projectData.clips,
          tracks: projectData.tracks,
          transitions: projectData.transitions,
          fps: projectData.fps,
        };

        // The encoder writes to config.fileHandle; the returned File is unused.
        await renderSelectionToVideoFile(fullTimelineSelection, {
          renderInputs: {
            exportConfig,
            projectData,
            brushMasksPrepared: true,
          },
          onProgress: (progress) => {
            run.reportProgress(progress);
            onProgress?.(progress);
          },
          format,
          keyFrameInterval,
          skipNormalize: true,
          filenamePrefix: "export",
          onRendererCreated: (renderer) =>
            registerRenderer(renderer, sessionId),
        });
        // A project export writes straight to the user's file handle, so it
        // has no asset to report — only that it finished.
        outcome = { status: "completed", assetId: null };
      } catch (e) {
        if (isAbortError(e)) {
          outcome = { status: "cancelled" };
        } else {
          outcome = { status: "failed", error: e };
          console.error("Export failed", e);
        }
      } finally {
        wakeLock?.release();
        finalizeSession(sessionId);
      }

      // Settled after teardown, so a subscriber told the render finished finds
      // a renderer that is free rather than one still holding its session.
      settleExportRun(run, outcome);
    },
    [
      beginSession,
      buildProjectData,
      finalizeSession,
      logicalDimensions,
      projectAspectRatio,
      registerRenderer,
    ],
  );

  /**
   * A render started from outside the editor UI still has to look like one to
   * the user: it holds the GPU for minutes and blocks the transport, so it
   * drives the same extraction dialog a user-confirmed selection render does.
   * That also hands the user the Cancel button, which is the only control they
   * would otherwise have over it.
   */
  const startRegistryRangeExport = useCallback(
    async (
      request: HostExportRunRequest,
      format: OutputVideoFormat,
      run: ExportRunHandle,
    ) => {
      const { openDialog, setDialogView, setIsProcessing, setProgress } =
        useExtractStore.getState();
      openDialog();
      setDialogView("extracting-selection");
      setIsProcessing(true);
      setProgress(0);

      const outcome = await executeRangeExport(
        {
          selectionStartTick: request.startTicks,
          selectionEndTick: request.endTicks,
          selectionMessage: null,
          selectionIncludedTrackIds: request.trackIds
            ? [...request.trackIds]
            : [],
          selectionFpsOverride: request.fps ?? null,
          selectionFrameStep: request.frameStep ?? 1,
          format,
          ...(request.keyFrameInterval !== undefined
            ? { keyFrameInterval: request.keyFrameInterval }
            : {}),
          onProgress: (progress) => {
            useExtractStore.getState().setProgress(progress);
          },
        },
        run,
      );

      // Order matters: the dialog's `isProcessing` is half of what `canStart`
      // reads, so it has to be released before the run announces that it
      // settled — otherwise an extension starting its next render from the
      // completion notification is refused by state the host is still holding.
      useExtractStore.getState().closeDialog();
      settleExportRun(run, outcome);
    },
    [executeRangeExport],
  );

  useEffect(
    () =>
      installHostExportController({
        // The log covers renders started anywhere; `isProcessing` covers the
        // dialog-driven flows that have not reached the renderer yet, and the
        // frame capture, which is not a run.
        canStart: () =>
          getActiveExportRun() === null &&
          !useExtractStore.getState().isProcessing,
        startRange: (request) => {
          const run = beginExportRun({
            kind: "range",
            startTicks: request.startTicks,
            endTicks: request.endTicks,
            formatId: request.formatId,
            ...(request.startedByExtension
              ? { startedByExtension: request.startedByExtension }
              : {}),
          });
          const format = narrowOutputFormat(request.format);
          if (format === null) {
            // Reported on the run rather than thrown: the caller already has
            // its ID, and the outcome of a render is something it observes.
            run.fail(new Error(`Unsupported output format '${request.format}'.`));
          } else {
            void startRegistryRangeExport(request, format, run);
          }
          return run.id;
        },
        cancel,
      }),
    [cancel, startRegistryRangeExport],
  );

  return {
    cancel,
    runSelectionExport,
    runProjectExport,
  };
}
