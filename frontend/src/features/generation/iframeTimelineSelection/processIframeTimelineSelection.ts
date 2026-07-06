import type { TimelineSelection } from "../../../types/TimelineTypes";
import { useProjectStore } from "../../project";
import {
  applyMaskCropProcessing,
  buildAspectRatioProcessingPlan,
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

export interface ProcessIframeTimelineSelectionDeps {
  renderWithMask: typeof renderTimelineSelectionToMp4WithMask;
  applyMaskCrop: typeof applyMaskCropProcessing;
  captureThumbnail: typeof captureFramePngAtTick;
}

const DEFAULT_DEPS: ProcessIframeTimelineSelectionDeps = {
  renderWithMask: renderTimelineSelectionToMp4WithMask,
  applyMaskCrop: applyMaskCropProcessing,
  captureThumbnail: captureFramePngAtTick,
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

  const rendered = await deps.renderWithMask(timelineSelection, "binary", {
    signal: options.signal,
    sourceVideoTreatment: "preserve_transparency",
    outputWidth: aspectPlan.metadata?.strided.width,
    outputHeight: aspectPlan.metadata?.strided.height,
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

  const thumbnail = await deps.captureThumbnail(
    timelineSelection.start,
    "iframe-timeline-selection",
    timelineSelection,
  );

  return {
    timelineSelection: structuredClone(timelineSelection),
    video: cropResult.video,
    mask: rendered.maskHasVisibleContent
      ? (cropResult.masks.video_binary ?? rendered.mask)
      : null,
    thumbnail,
    aspectRatioProcessing: aspectPlan.metadata,
    maskCropMetadata: cropResult.metadata,
    warnings,
  };
}
