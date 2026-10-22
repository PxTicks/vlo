import { useProjectStore } from "../../project";
import { normalizeAspectRatio } from "../../project/aspectRatioOptions";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import { resolveRegionRenderResolution } from "../../timelineSelection/utils/selectionRenderResolution";
import {
  getTimelineClips,
  getTimelineDuration,
  getTimelineTracks,
  getTimelineTransitions,
} from "../../timeline/api";
import { getAssets } from "../../userAssets";
import { getCompositeAssets } from "../../composite";
import { prepareBrushMasksForTimelineRender } from "../../masks/api";
import { encodeRgbaPng } from "../../../core/media";
import {
  hasFullyTransparentPixel,
  mergeMaskedFramePixels,
} from "../utils/maskedFramePixels";
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
  /**
   * Keep the colour of pixels hidden by masks under zero alpha, instead of
   * the black a canvas encoder leaves there. The alpha channel still carries
   * the mask. Costs a second, unmasked render when masks are present. PNG only.
   */
  preserveMaskedPixels?: boolean;
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

/** Detached selections retain their original canvas; project renders use live settings. */
export function buildProjectRenderInputs(
  timelineSelection?: TimelineSelection,
): ProjectRenderInputs {
  const projectStore = useProjectStore.getState();
  const assets = getAssets();

  const aspectRatio =
    normalizeAspectRatio(timelineSelection?.aspectRatio) ??
    projectStore.config.aspectRatio;
  const outputResolution = resolveRegionRenderResolution(
    timelineSelection,
    projectStore.config.outputResolution,
  );
  const logicalDimensions = getProjectDimensions(aspectRatio);
  const outputDimensions = resolveRenderOutputDimensions(
    aspectRatio,
    outputResolution,
  );

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
  const { exportConfig, projectData } = buildProjectRenderInputs(options.timelineSelection);
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

function hasTimelineMaskClips(): boolean {
  return getTimelineClips().some((clip) => clip.type === "mask");
}

async function decodeRgbaPixels(
  blob: Blob,
  width: number,
  height: number,
): Promise<Uint8ClampedArray> {
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  try {
    const canvas =
      typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement("canvas"), { width, height });
    const context = canvas.getContext("2d") as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!context) {
      throw new Error("Failed to acquire a 2D context to read frame pixels");
    }
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  } finally {
    bitmap.close();
  }
}

/**
 * Renders the frame with and without masks and merges them (see
 * {@link mergeMaskedFramePixels}). Falls back to the single masked render
 * whenever there is nothing hidden to recover.
 */
async function renderFramePreservingMaskedPixels(
  tick: number,
  options: ProjectFrameCaptureOptions,
): Promise<Blob> {
  const masked = await renderProjectFrameAtTick(tick, options);
  if (options.includeTimelineMasks === false || !hasTimelineMaskClips()) {
    return masked.blob;
  }
  const { width, height } = masked;
  const maskedPixels = await decodeRgbaPixels(masked.blob, width, height);
  if (!hasFullyTransparentPixel(maskedPixels)) {
    return masked.blob;
  }

  const unmasked = await renderProjectFrameAtTick(tick, {
    ...options,
    includeTimelineMasks: false,
  });
  if (unmasked.width !== width || unmasked.height !== height) {
    throw new Error(
      `Unmasked frame rendered at ${unmasked.width}x${unmasked.height}, expected ${width}x${height}`,
    );
  }
  const unmaskedPixels = await decodeRgbaPixels(unmasked.blob, width, height);
  return encodeRgbaPng(
    mergeMaskedFramePixels(maskedPixels, unmaskedPixels),
    width,
    height,
  );
}

export async function renderProjectFrameFileAtTick(
  tick: number,
  options: ProjectFrameCaptureOptions = {},
): Promise<File> {
  const mimeType = options.mimeType ?? "image/png";
  const filenamePrefix = options.filenamePrefix ?? "frame";
  if (options.preserveMaskedPixels && mimeType !== "image/png") {
    throw new Error("Preserving masked pixels requires a PNG capture");
  }
  const blob = options.preserveMaskedPixels
    ? await renderFramePreservingMaskedPixels(tick, options)
    : (await renderProjectFrameAtTick(tick, options)).blob;
  const now = Date.now();

  return new File([blob], `${filenamePrefix}-${now}.${resolveExtension(mimeType)}`, {
    type: mimeType,
    lastModified: now,
  });
}
