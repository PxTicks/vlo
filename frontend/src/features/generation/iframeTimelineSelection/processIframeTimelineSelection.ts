import type { TimelineSelection } from "../../../types/TimelineTypes";
import { captureVideoFrameFile } from "../../../core/media";
import { useProjectStore } from "../../project";
import {
  MASK_CROP_VIDEO_BITRATE,
  applyMaskCropProcessing,
  buildAspectRatioProcessingPlan,
  resizeVideoToDimensions,
  type MaskCropProcessingResult,
} from "../processing";
import {
  captureFramePngAtTick,
  renderTimelineSelectionToMp4WithMask,
} from "../utils/inputSelection";
import type {
  IframeTimelineSelectionSettings,
  ProcessedIframeTimelineSelection,
} from "./types";

/**
 * Captures the mask matte's own first frame so the mask card renders the
 * black/white matte instead of reusing the source video's poster (which read
 * as a duplicate "two videos" card).
 */
async function captureMaskThumbnailFile(maskFile: File): Promise<File> {
  const url = URL.createObjectURL(maskFile);
  try {
    return await captureVideoFrameFile(
      url,
      0,
      `iframe-timeline-selection-mask-thumb-${Date.now()}.png`,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface ProcessIframeTimelineSelectionDeps {
  renderWithMask: typeof renderTimelineSelectionToMp4WithMask;
  applyMaskCrop: typeof applyMaskCropProcessing;
  resizeVideo: typeof resizeVideoToDimensions;
  captureThumbnail: typeof captureFramePngAtTick;
  captureMaskThumbnail: (maskFile: File) => Promise<File>;
}

const DEFAULT_DEPS: ProcessIframeTimelineSelectionDeps = {
  renderWithMask: renderTimelineSelectionToMp4WithMask,
  applyMaskCrop: applyMaskCropProcessing,
  resizeVideo: resizeVideoToDimensions,
  captureThumbnail: captureFramePngAtTick,
  captureMaskThumbnail: captureMaskThumbnailFile,
};

export function createDefaultIframeTimelineSelectionSettings(): IframeTimelineSelectionSettings {
  return {
    aspectRatio: {
      enabled: false,
      targetAspectRatio: useProjectStore.getState().config.aspectRatio,
      targetResolution: 720,
      stride: 16,
      searchSteps: 2,
    },
    maskCrop: {
      mode: "crop",
      dilation: 0.1,
    },
  };
}

export async function processIframeTimelineSelection(
  timelineSelection: TimelineSelection,
  settings: IframeTimelineSelectionSettings,
  options: {
    signal?: AbortSignal;
    deps?: ProcessIframeTimelineSelectionDeps;
  } = {},
): Promise<ProcessedIframeTimelineSelection> {
  const deps = options.deps ?? DEFAULT_DEPS;
  const warnings: ProcessedIframeTimelineSelection["warnings"] = [];
  const aspectPlan = settings.aspectRatio.enabled
    ? buildAspectRatioProcessingPlan({
        targetAspectRatio: settings.aspectRatio.targetAspectRatio,
        targetResolution: settings.aspectRatio.targetResolution,
        config: {
          stride: settings.aspectRatio.stride,
          search_steps: settings.aspectRatio.searchSteps,
        },
      })
    : { metadata: null, warnings: [] };
  warnings.push(...aspectPlan.warnings);

  if (settings.aspectRatio.enabled && !aspectPlan.metadata) {
    throw new Error(
      aspectPlan.warnings[0]?.message ??
        "Invalid aspect-ratio processing settings",
    );
  }

  // Render (and later crop) at the project's own render dimensions, matching
  // the backend which crops the uploaded input `before_upload` at native dims.
  // Strided resizing is a separate, later step (below), so the crop is taken
  // from full-fidelity project pixels and the mask-crop metadata is emitted in
  // project (== logical) space — keeping timeline placement correct.
  const rendered = await deps.renderWithMask(timelineSelection, "binary", {
    signal: options.signal,
    sourceVideoTreatment: "preserve_transparency",
  });

  let cropResult: MaskCropProcessingResult = {
    video: rendered.video,
    masks: {},
    metadata: { mode: "full" },
    warnings: [],
  };
  if (rendered.maskHasVisibleContent) {
    cropResult = await deps.applyMaskCrop({
      video: rendered.video,
      masks: { video_binary: rendered.mask },
      targetAspectRatio:
        aspectPlan.metadata?.requested.aspect_ratio ??
        useProjectStore.getState().config.aspectRatio,
      cropMode: settings.maskCrop.mode,
      cropDilation: settings.maskCrop.dilation,
      signal: options.signal,
    });
    warnings.push(...cropResult.warnings);
  }

  let video = cropResult.video;
  let mask = rendered.maskHasVisibleContent
    ? (cropResult.masks.video_binary ?? rendered.mask)
    : null;

  // Frontend substitute for the backend aspect-ratio stage (which hijacks the
  // workflow's resize nodes rather than the media): stretch the cropped content
  // to the model-friendly strided dimensions. Doing this after the crop is what
  // keeps the stride guarantee — the previous order cropped a strided render and
  // shipped crop-region-sized (non-strided) files.
  const strided = aspectPlan.metadata?.strided;
  if (strided) {
    video = await deps.resizeVideo(video, strided.width, strided.height, {
      signal: options.signal,
    });
    if (mask) {
      mask = await deps.resizeVideo(mask, strided.width, strided.height, {
        signal: options.signal,
        bitrate: MASK_CROP_VIDEO_BITRATE,
      });
    }
  }

  const thumbnail = await deps.captureThumbnail(
    timelineSelection.start,
    "iframe-timeline-selection",
    timelineSelection,
  );

  const maskThumbnail = mask ? await deps.captureMaskThumbnail(mask) : null;

  return {
    timelineSelection: structuredClone(timelineSelection),
    video,
    mask,
    maskThumbnail,
    thumbnail,
    aspectRatioProcessing: aspectPlan.metadata,
    maskCropMetadata: cropResult.metadata,
    warnings,
  };
}
