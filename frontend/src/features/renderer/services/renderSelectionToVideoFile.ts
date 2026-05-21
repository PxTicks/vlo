import type { TimelineSelection } from "../../../types/TimelineTypes";
import { normalizeTimelineSelection } from "../../timelineSelection";
import {
  ExportRenderer,
  type ExportConfig,
  type ProjectData,
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
}

/**
 * Single source of truth for "render a {@link TimelineSelection} to an mp4
 * File". Wraps the `ExportRenderer.create → render → File` sequence so callers
 * (generation input prep, the composite proxy bake, selection/project export)
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
    },
  );

  const prefix = options.filenamePrefix ?? "selection";
  return new File([result.video], `${prefix}-${Date.now()}.mp4`, {
    type: "video/mp4",
    lastModified: Date.now(),
  });
}
