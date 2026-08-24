import { useProjectStore } from "../../project";
import {
  getTimelineClips,
  getTimelineDuration,
  getTimelineTracks,
  getTimelineTransitions,
} from "../../timeline/api";
import { getAssets } from "../../userAssets";
import { getCompositeAssets } from "../../composite";
import { prepareBrushMasksForTimelineRender } from "../../masks/api";
import {
  getProjectDimensions,
  resolveRenderOutputDimensions,
} from "../utils/dimensions";
import {
  ExportRenderer,
  type ExportConfig,
  type ProjectData,
  type RenderStillOptions,
} from "./ExportRenderer";

export interface ProjectRenderInputs {
  exportConfig: ExportConfig;
  projectData: ProjectData;
}

export interface ProjectFrameCaptureOptions extends RenderStillOptions {
  filenamePrefix?: string;
}

function resolveExtension(mimeType: "image/png" | "image/webp"): string {
  switch (mimeType) {
    case "image/webp":
      return "webp";
    case "image/png":
    default:
      return "png";
  }
}

export function buildProjectRenderInputs(): ProjectRenderInputs {
  const projectStore = useProjectStore.getState();
  const assets = getAssets();

  const { aspectRatio } = projectStore.config;
  const logicalDimensions = getProjectDimensions(aspectRatio);
  const outputDimensions = resolveRenderOutputDimensions(aspectRatio);

  const exportConfig: ExportConfig = {
    logicalWidth: logicalDimensions.width,
    logicalHeight: logicalDimensions.height,
    outputWidth: outputDimensions.width,
    outputHeight: outputDimensions.height,
    backgroundAlpha: 0,
  };

  const projectData: ProjectData = {
    tracks: getTimelineTracks(),
    clips: getTimelineClips(),
    transitions: getTimelineTransitions(),
    composites: getCompositeAssets(),
    assets,
    duration: getTimelineDuration(),
    fps: projectStore.config.fps,
  };

  return { exportConfig, projectData };
}

export interface CapturedProjectFrame {
  blob: Blob;
  /** Output pixel dimensions: the project ratio at the render short edge. */
  width: number;
  height: number;
}

/**
 * Renders one composited project frame. Split out from
 * {@link renderProjectFrameFileAtTick} so callers that want pixels rather than
 * an ingestible file — `api.export.renderFrame` — get the dimensions with them
 * instead of having to re-derive the project's.
 */
export async function renderProjectFrameAtTick(
  tick: number,
  options: RenderStillOptions = {},
): Promise<CapturedProjectFrame> {
  const preparedSelection = await prepareBrushMasksForTimelineRender(
    options.timelineSelection,
    { refreshSelectionClips: false },
  );
  const { exportConfig, projectData } = buildProjectRenderInputs();
  const renderer = await ExportRenderer.create(exportConfig);
  const blob = await renderer.renderStill(projectData, exportConfig, tick, {
    ...options,
    ...(preparedSelection ? { timelineSelection: preparedSelection } : {}),
  });

  return {
    blob,
    width: exportConfig.outputWidth,
    height: exportConfig.outputHeight,
  };
}

export async function renderProjectFrameFileAtTick(
  tick: number,
  options: ProjectFrameCaptureOptions = {},
): Promise<File> {
  const mimeType = options.mimeType ?? "image/png";
  const filenamePrefix = options.filenamePrefix ?? "frame";
  const { blob } = await renderProjectFrameAtTick(tick, options);
  const now = Date.now();

  return new File([blob], `${filenamePrefix}-${now}.${resolveExtension(mimeType)}`, {
    type: mimeType,
    lastModified: now,
  });
}
