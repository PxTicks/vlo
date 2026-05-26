import { useProjectStore } from "../../project";
import { getTimelineDuration, useTimelineStore } from "../../timeline";
import { getAssets } from "../../userAssets";
import { getProjectDimensions } from "../utils/dimensions";
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
  const timelineStore = useTimelineStore.getState();
  const assets = getAssets();

  const logicalDimensions = getProjectDimensions(projectStore.config.aspectRatio);
  const outputWidth = Math.max(2, Math.round(logicalDimensions.width / 2) * 2);
  const outputHeight = Math.max(
    2,
    Math.round(logicalDimensions.height / 2) * 2,
  );

  const exportConfig: ExportConfig = {
    logicalWidth: logicalDimensions.width,
    logicalHeight: logicalDimensions.height,
    outputWidth,
    outputHeight,
    backgroundAlpha: 0,
  };

  const projectData: ProjectData = {
    tracks: timelineStore.tracks,
    clips: timelineStore.clips,
    assets,
    duration: getTimelineDuration(),
    fps: projectStore.config.fps,
  };

  return { exportConfig, projectData };
}

export async function renderProjectFrameFileAtTick(
  tick: number,
  options: ProjectFrameCaptureOptions = {},
): Promise<File> {
  const mimeType = options.mimeType ?? "image/png";
  const filenamePrefix = options.filenamePrefix ?? "frame";
  const { exportConfig, projectData } = buildProjectRenderInputs();
  const renderer = await ExportRenderer.create(exportConfig);
  const blob = await renderer.renderStill(projectData, exportConfig, tick, options);
  const now = Date.now();

  return new File([blob], `${filenamePrefix}-${now}.${resolveExtension(mimeType)}`, {
    type: mimeType,
    lastModified: now,
  });
}
