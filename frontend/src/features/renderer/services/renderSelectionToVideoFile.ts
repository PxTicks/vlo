import type { TimelineSelection } from "../../../types/TimelineTypes";
import { prepareBrushMasksForTimelineRender } from "../../masks/api";
import { normalizeDetachedTimelineSelection } from "../../timelineSelection";
import { preloadColorGradeLuts } from "../../transformations/catalogue/filters/colorGrade/lutTexture";
import {
  ExportRenderer,
  type ExportConfig,
  type ExportRenderHealth,
  type ProjectData,
  type RenderedFramePixelCapture,
} from "./ExportRenderer";
import { buildProjectRenderInputs } from "./projectFrameCapture";
import type { OutputVideoFormat } from "./TextureOutputEncoder";

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
  /** Output container. WebM is used for alpha-preserving composite caches. */
  format?: OutputVideoFormat;
  /** Seconds between keyframes in the rendered video. */
  keyFrameInterval?: number;
  preserveAlpha?: boolean;
  /** Base name for the produced File; timestamp and extension are appended. */
  filenamePrefix?: string;
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
 * `File`. Wraps the `ExportRenderer.create → render → File` sequence so callers
 * (generation input prep, the composite bake, selection/project export)
 * don't each re-implement it. The renderer disposes itself in `render()`.
 */
export async function renderSelectionToVideoFile(
  timelineSelection: TimelineSelection,
  options: RenderSelectionToVideoFileOptions = {},
): Promise<File> {
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
    options.renderInputs ?? buildProjectRenderInputs();
  const selection = options.skipNormalize
    ? preparedTimelineSelection
    : normalizeDetachedTimelineSelection(preparedTimelineSelection);

  // Strict rendering starts pulling frames immediately; referenced grade LUTs
  // must be cached up front or early frames would render without them.
  await preloadColorGradeLuts(selection.clips);

  const renderer = await ExportRenderer.create(exportConfig);
  try {
    options.onRendererCreated?.(renderer);
  } catch (error) {
    renderer.dispose();
    throw error;
  }

  const result = await renderer.render(
    projectData,
    exportConfig,
    (percentage) => options.onProgress?.(percentage),
    {
      timelineSelection: selection,
      format: options.format ?? "mp4",
      keyFrameInterval: options.keyFrameInterval,
      preserveAlpha: options.preserveAlpha,
      includeTimelineMasks: options.includeTimelineMasks,
      signal: options.signal,
      ...(options.onBeforeEncodeFrame
        ? { onBeforeEncodeFrame: options.onBeforeEncodeFrame }
        : {}),
    },
  );

  options.onRenderHealth?.(result.renderHealth);

  const prefix = options.filenamePrefix ?? "selection";
  const format = options.format ?? "mp4";
  const mimeType = format === "webm" ? "video/webm" : "video/mp4";
  return new File([result.video], `${prefix}-${Date.now()}.${format}`, {
    type: mimeType,
    lastModified: Date.now(),
  });
}
