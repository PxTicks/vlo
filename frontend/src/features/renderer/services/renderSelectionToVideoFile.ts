import type { ExportPhase } from "../../../core/export/exportProgress";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import { prepareBrushMasksForTimelineRender } from "../../masks/api";
import { normalizeDetachedTimelineSelection } from "../../timelineSelection";
import { preloadColorGradeLuts } from "../../transformations/catalogue/filters/colorGrade/lutTexture";
import {
  ExportRenderer,
  type ExportConfig,
  type RenderResult,
  type ExportRenderHealth,
  type ProjectData,
  type RenderedFramePixelCapture,
} from "./ExportRenderer";
import { buildProjectRenderInputs } from "./projectFrameCapture";
import type { OutputVideoFormat } from "./TextureOutputEncoder";
import type { ExportDiagnostic } from "./exportDiagnostics";
import { startExportDebugLog } from "./exportDebugLog";
import { isAbortError } from "./framePlanning/BatchFrameGraphExecutor";

export interface SelectionRenderInputs {
  exportConfig: ExportConfig;
  projectData: ProjectData;
  /**
   * Confirms that any live brush pixels were materialized before projectData
   * was captured. Detached/synthetic inputs may set this when they contain no
   * live brush authoring state.
   */
  brushMasksPrepared: true;
}

export interface RenderSelectionToVideoFileOptions {
  /**
   * Render against caller-supplied inputs instead of the global timeline store.
   * Used for in-memory timelines (composite content, the modal video editor)
   * and to reuse an export-specific ExportConfig.
   */
  renderInputs?: SelectionRenderInputs;
  includeTimelineMasks?: boolean;
  signal?: AbortSignal;
  onProgress?: (percentage: number) => void;
  onPhaseChange?: (phase: ExportPhase) => void;
  onDiagnostic?: (event: ExportDiagnostic) => void;
  /** Output container. WebM is used for alpha-preserving composite caches. */
  format?: OutputVideoFormat;
  /** Seconds between keyframes in the rendered video. */
  keyFrameInterval?: number;
  /** Whether the output carries a soundtrack. Defaults to true. */
  includeAudio?: boolean;
  preserveAlpha?: boolean;
  /** Base name for the produced File; timestamp and extension are appended. */
  filenamePrefix?: string;
  /** Names this render in debug-mode console diagnostics. */
  debugLabel?: string;
  /**
   * Invoked with the renderer immediately after creation — e.g. to register it
   * with a cancellation session. Throwing here disposes the renderer.
   */
  onRendererCreated?: (renderer: ExportRenderer) => void;
  /** Skip selection normalization (caller passes an already-built selection). */
  skipNormalize?: boolean;
  /**
   * Receives the render's strict-frame health tally before the File is
   * returned. Callers that must not ship blank output (e.g. generation input
   * prep) can inspect it and throw.
   */
  onRenderHealth?: (renderHealth: ExportRenderHealth | undefined) => void;
  /** Captures project-composite pixels immediately before video encoding. */
  onBeforeEncodeFrame?: (
    frame: RenderedFramePixelCapture,
  ) => void | Promise<void>;
}

/**
 * Single source of truth for rendering a {@link TimelineSelection} to a video
 * output bundle. Wraps the `ExportRenderer.create → render` sequence so callers
 * (generation input prep, the composite bake, selection/project export)
 * don't each re-implement it. The renderer disposes itself in `render()`.
 */
export async function renderSelectionToOutput(
  timelineSelection: TimelineSelection,
  options: RenderSelectionToVideoFileOptions = {},
): Promise<RenderResult> {
  if (
    options.renderInputs &&
    options.renderInputs.brushMasksPrepared !== true
  ) {
    throw new Error(
      "Caller-supplied render inputs must prepare brush masks before snapshotting",
    );
  }
  const preparedTimelineSelection = options.renderInputs
    ? timelineSelection
    : ((await prepareBrushMasksForTimelineRender(timelineSelection, {
        refreshSelectionClips: false,
      })) ?? timelineSelection);
  const { exportConfig, projectData } =
    options.renderInputs ?? buildProjectRenderInputs(timelineSelection);
  const selection = options.skipNormalize
    ? preparedTimelineSelection
    : normalizeDetachedTimelineSelection(preparedTimelineSelection, projectData.fps);

  // Strict rendering starts pulling frames immediately; referenced grade LUTs
  // must be cached up front or early frames would render without them. Read
  // from the render's own assets, which a detached realm's library lacks.
  await preloadColorGradeLuts(selection.region.clips, {
    strict: true,
    assets: projectData.assets,
  });

  const renderer = await ExportRenderer.create(exportConfig);
  try {
    options.onRendererCreated?.(renderer);
  } catch (error) {
    renderer.dispose();
    throw error;
  }

  // Started with the render, so debug mode toggled mid-render changes nothing.
  const debugLog = startExportDebugLog(
    options.debugLabel ?? options.filenamePrefix ?? "render",
  );
  const onDiagnostic = debugLog
    ? (event: ExportDiagnostic) => {
        debugLog.onDiagnostic(event);
        options.onDiagnostic?.(event);
      }
    : options.onDiagnostic;

  let result: RenderResult;
  try {
    result = await renderer.render(
      projectData,
      exportConfig,
      (percentage) => options.onProgress?.(percentage),
      {
        timelineSelection: selection,
        onPhaseChange: debugLog
          ? (phase) => {
              debugLog.onPhaseChange(phase);
              options.onPhaseChange?.(phase);
            }
          : options.onPhaseChange,
        ...(onDiagnostic ? { onDiagnostic } : {}),
        format: options.format ?? "mp4",
        keyFrameInterval: options.keyFrameInterval,
        ...(options.includeAudio !== undefined
          ? { includeAudio: options.includeAudio }
          : {}),
        preserveAlpha: options.preserveAlpha,
        includeTimelineMasks: options.includeTimelineMasks,
        signal: options.signal,
        ...(options.onBeforeEncodeFrame
          ? { onBeforeEncodeFrame: options.onBeforeEncodeFrame }
          : {}),
      },
    );
    debugLog?.finish("completed");
  } catch (error) {
    debugLog?.finish(isAbortError(error) ? "cancelled" : "failed");
    throw error;
  }

  options.onRenderHealth?.(result.renderHealth);

  return result;
}

export async function renderSelectionToVideoFile(
  timelineSelection: TimelineSelection,
  options: RenderSelectionToVideoFileOptions = {},
): Promise<File> {
  if (options.renderInputs?.exportConfig.fileHandle) {
    throw new Error("Use renderSelectionToOutput for disk exports");
  }
  const result = await renderSelectionToOutput(timelineSelection, options);
  if (!result.video) throw new Error("Renderer produced no video blob");
  const prefix = options.filenamePrefix ?? "selection";
  const format = options.format ?? "mp4";
  const mimeType = format === "webm" ? "video/webm" : "video/mp4";
  return new File([result.video], `${prefix}-${Date.now()}.${format}`, {
    type: mimeType,
    lastModified: Date.now(),
  });
}
