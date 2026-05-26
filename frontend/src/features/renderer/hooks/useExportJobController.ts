import { useCallback, useEffect, useRef } from "react";
import { getTimelineDuration, useTimelineStore } from "../../timeline";
import { addLocalAsset, getAssets } from "../../userAssets";
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
import { deriveTrueDimensionsFromShortEdge } from "../utils/dimensions";
import type { AspectRatio } from "../../project/useProjectStore";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createAbortError(): Error {
  const error = new Error("Render cancelled");
  error.name = "AbortError";
  return error;
}

export interface SelectionExportOptions {
  selectionStartTick: number;
  selectionEndTick: number;
  selectionMessage: string | null;
  selectionIncludedTrackIds: string[];
  selectionFpsOverride: number | null;
  selectionFrameStep: number;
  onProgress?: (progress: number) => void;
}

export interface ProjectExportOptions {
  resolution: number;
  fileHandle?: FileSystemFileHandle;
  onProgress?: (progress: number) => void;
}

export interface UseExportJobControllerOptions {
  projectAspectRatio: AspectRatio;
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
    const store = useTimelineStore.getState();
    const assets = getAssets();
    const duration = getTimelineDuration();

    return {
      tracks: store.tracks,
      clips: store.clips,
      assets,
      duration,
      fps: projectFps,
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

  const runSelectionExport = useCallback(
    async ({
      selectionStartTick,
      selectionEndTick,
      selectionMessage,
      selectionIncludedTrackIds,
      selectionFpsOverride,
      selectionFrameStep,
      onProgress,
    }: SelectionExportOptions) => {
      const sessionId = beginSession();
      const aspectRatio = logicalDimensions.width / logicalDimensions.height;
      const outputHeight = Math.round(logicalDimensions.height / 2) * 2;
      const outputWidth = Math.round((outputHeight * aspectRatio) / 2) * 2;

      const exportConfig: ExportConfig = {
        logicalWidth: logicalDimensions.width,
        logicalHeight: logicalDimensions.height,
        outputWidth,
        outputHeight,
        backgroundAlpha: 0,
      };

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
        ...(selectionMessage ? { message: selectionMessage } : {}),
        ...(selectionIncludedTrackIds.length > 0
          ? { includedTrackIds: selectionIncludedTrackIds.slice() }
          : {}),
        fps: selectionFps,
        frameStep: selectionFrameStep,
      };

      try {
        const file = await renderSelectionToVideoFile(
          selectionTimelineSelection,
          {
            renderInputs: { exportConfig, projectData },
            onProgress,
            skipNormalize: true,
            filenamePrefix: "selection",
            onRendererCreated: (renderer) =>
              registerRenderer(renderer, sessionId),
          },
        );

        await addLocalAsset(file, {
          source: "extracted",
          timelineSelection: selectionTimelineSelection,
        });
      } catch (e) {
        if (!isAbortError(e)) {
          console.error("Selection extraction failed", e);
        }
      } finally {
        finalizeSession(sessionId);
      }
    },
    [
      beginSession,
      buildProjectData,
      finalizeSession,
      logicalDimensions,
      registerRenderer,
    ],
  );

  const runProjectExport = useCallback(
    async ({ resolution, fileHandle, onProgress }: ProjectExportOptions) => {
      const sessionId = beginSession();
      const trueDimensions = deriveTrueDimensionsFromShortEdge(
        projectAspectRatio,
        resolution,
      );
      const outputWidth = Math.max(2, Math.round(trueDimensions.width / 2) * 2);
      const outputHeight = Math.max(
        2,
        Math.round(trueDimensions.height / 2) * 2,
      );

      const exportConfig: ExportConfig = {
        logicalWidth: logicalDimensions.width,
        logicalHeight: logicalDimensions.height,
        outputWidth,
        outputHeight,
        fileHandle,
      };

      const projectData = buildProjectData();
      const fullTimelineSelection = {
        start: 0,
        end: projectData.duration,
        clips: projectData.clips,
        fps: projectData.fps,
      };

      try {
        // The encoder writes to config.fileHandle; the returned File is unused.
        await renderSelectionToVideoFile(fullTimelineSelection, {
          renderInputs: { exportConfig, projectData },
          onProgress,
          skipNormalize: true,
          filenamePrefix: "export",
          onRendererCreated: (renderer) =>
            registerRenderer(renderer, sessionId),
        });
      } catch (e) {
        if (!isAbortError(e)) {
          console.error("Export failed", e);
        }
      } finally {
        finalizeSession(sessionId);
      }
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

  return {
    cancel,
    runSelectionExport,
    runProjectExport,
  };
}
