import type { TimelineSelection } from "../../../types/TimelineTypes";
import { normalizeTimelineSelection } from "../../timelineSelection";
import { preloadColorGradeLuts } from "../../transformations/catalogue/filters/colorGrade/lutTexture";
import {
  ExportRenderer,
  type ExportConfig,
  type ExportRenderHealth,
  type ProjectData,
  type RenderedFramePixelCapture,
} from "./ExportRenderer";
import { buildProjectRenderInputs } from "./projectFrameCapture";

export interface SelectionRenderInputs {
  exportConfig: ExportConfig;
  projectData: ProjectData;
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
  /** Base name for the produced File (a `-<timestamp>.mp4` suffix is appended). */
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
 * Single source of truth for "render a {@link TimelineSelection} to an mp4
 * File". Wraps the `ExportRenderer.create → render → File` sequence so callers
 * (generation input prep, the composite bake, selection/project export)
 * don't each re-implement it. The renderer disposes itself in `render()`.
 */
export async function renderSelectionToVideoFile(
  timelineSelection: TimelineSelection,
  options: RenderSelectionToVideoFileOptions = {},
): Promise<File> {
  const { exportConfig, projectData } =
    options.renderInputs ?? buildProjectRenderInputs();
  const selection = options.skipNormalize
    ? timelineSelection
    : normalizeTimelineSelection(timelineSelection, projectData.clips);

  // Strict rendering starts pulling frames immediately; referenced grade LUTs
  // must be cached up front or early frames would render without them.
  await preloadColorGradeLuts(projectData.clips);

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
      format: "mp4",
      includeTimelineMasks: options.includeTimelineMasks,
      signal: options.signal,
      ...(options.onBeforeEncodeFrame
        ? { onBeforeEncodeFrame: options.onBeforeEncodeFrame }
        : {}),
    },
  );

  options.onRenderHealth?.(result.renderHealth);

  const prefix = options.filenamePrefix ?? "selection";
  return new File([result.video], `${prefix}-${Date.now()}.mp4`, {
    type: "video/mp4",
    lastModified: Date.now(),
  });
}
