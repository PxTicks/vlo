/**
 * Frontend media-processing routines for generation dispatch: aspect-ratio
 * strided-dimension planning and mask-bounds cropping. These mirror the
 * backend `gen_pipeline` processors (see the module docs for parity notes)
 * so the advanced timeline-selection flow can process media client-side.
 */

export {
  buildAspectRatioProcessingPlan,
  deriveTrueDimensionsFromShortEdge,
  findBestStridedDimensions,
  parseAspectRatioParts,
  pythonRound,
  toStrictPositiveInteger,
  type AspectRatioProcessingPlanConfig,
  type AspectRatioProcessingPlanInput,
  type AspectRatioProcessingPlanResult,
  type ProcessingWarning,
  type StridedDimensionsCandidate,
} from "./aspectRatioProcessing";
export {
  MASK_VIDEO_WHITE_THRESHOLD,
  computeCropRegion,
  computeMaskCrop,
  forceAspectRatio,
  getMaskBoundsFromChannel,
  getMaskBoundsFromRgba,
  unionBounds,
  type MaskBounds,
} from "./maskCropMath";
export {
  analyzeMaskVideoBounds,
  probeVideoDimensions,
  type AnalyzeMaskVideoBoundsOptions,
  type MaskVideoBoundsAnalysis,
  type VideoDimensions,
} from "./maskVideoAnalysis";
export {
  MASK_CROP_VIDEO_BITRATE,
  cropVideoToRect,
  type CropVideoToRectOptions,
} from "./videoRectCrop";
export {
  applyMaskCropProcessing,
  isAudioTimingMaskRenderKey,
  type MaskCropMode,
  type MaskCropProcessingDeps,
  type MaskCropProcessingInput,
  type MaskCropProcessingResult,
} from "./maskCropProcessing";
