export { useTrackRenderEngine } from "./hooks/useTrackRenderEngine";
export type { TrackRenderEngineResult } from "./hooks/useTrackRenderEngine";
export { getViewportContentTarget, useViewport } from "./hooks/useViewport";
export { useAudioTrack } from "./hooks/useAudioTrack";
export { useExportJobController } from "./hooks/useExportJobController";
export { AudioTrackLayer } from "./components/AudioTrackLayer";
export { TrackRenderEngine } from "./services/TrackRenderEngine";
export {
  createCompositeSourcePolicySnapshot,
  LiveFrameGraphCoordinator,
  isLiveFrameGraphEnabled,
  startFramePlanningDiagnosticsConsole,
} from "./services/framePlanning";
export { ExportRenderer, isBlankStrictRenderHealth } from "./services/ExportRenderer";
export type {
  ExportConfig,
  ExportRenderHealth,
  ProjectData,
  RenderOptions,
  RenderedFramePixelCapture,
  RenderStillOptions,
  RenderResult,
} from "./services/ExportRenderer";
export type { StrictRenderHealth } from "./services/TrackRenderEngine";
export type {
  OutputVideoDefinition,
  OutputVideoFormat,
} from "./services/TextureOutputEncoder";
export { TrackAudioRenderer } from "./services/TrackAudioRenderer";
export { CompositeAudioTrackRenderer } from "./services/CompositeAudioTrackRenderer";
export type { CompositeAudioSourceData } from "./services/CompositeAudioResolver";
export {
  buildProjectRenderInputs,
  renderProjectFrameAtTick,
  renderProjectFrameFileAtTick,
} from "./services/projectFrameCapture";
export type { CapturedProjectFrame } from "./services/projectFrameCapture";
export { renderSelectionToVideoFile } from "./services/renderSelectionToVideoFile";
export type {
  SelectionRenderInputs,
  RenderSelectionToVideoFileOptions,
} from "./services/renderSelectionToVideoFile";
export type { ProjectFrameCaptureOptions } from "./services/projectFrameCapture";
export {
  getProjectDimensions,
  resolveRenderOutputDimensions,
} from "./utils/dimensions";
export {
  resolveCompositePreviewRasterDimensions,
} from "./utils/compositeRasterDimensions";
export { syncContainerTransformToTarget } from "./utils/displayObjectSync";
export {
  calculatePlayerFrameTime,
  snapFrameTimeSeconds,
  tickToMediaSeconds,
  mediaSecondsToTick,
  mediaSecondsToTickExact,
  mediaTimestampToFirstAvailableTick,
  frameIndexToOutputTimestamp,
} from "./utils/mediaTime";
export {
  createSourceFrameSyncRef,
  createSourceFrameSyncRefFromSourceTicks,
  createSourceFrameSyncKey,
  isSourceFrameIntentCurrent,
} from "./utils/sourceFrameSync";
export type {
  SourceFrameSyncIntent,
  SourceFrameSyncRef,
} from "./utils/sourceFrameSync";
export {
  createBinaryMaskOutputFilter,
  createFilterStackTransform,
  createNonBinaryMaskOutputColorMatrixFilter,
  createOpaqueOutputColorMatrixFilter,
} from "./utils/outputTransformStack";
export {
  createDecoderWorkerPool,
  getSharedDecoderWorkerPool,
  type DecoderLease,
  type DecoderLeaseEvents,
  type DecoderStallResolution,
  type DecoderWorkerPool,
} from "./services/DecoderWorkerPool";
