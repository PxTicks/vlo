export type { TimelineSelection } from "../../types/TimelineTypes";
export {
  getTimelineSelectionStoreForTrustedHostAccess,
  useTimelineSelectionStore,
} from "./useTimelineSelectionStore";
export {
  getIncludedClipsForSelection,
  getIncludedTracksForSelection,
  getClipsInSelection,
  getTicksPerFrame,
  normalizeTimelineSelection,
  normalizeDetachedTimelineSelection,
  resolveSelectionFps,
  resolveSelectionFrameOffset,
  resolveSelectionFrameStep,
  selectionHasMaskClip,
  snapFrameCountToStep,
  snapSteppedRangeEdge,
  snapTickToFrame,
} from "./utils/timelineSelection";
export type { SnapSteppedRangeEdgeOptions } from "./utils/timelineSelection";
export {
  createTimelineSelection,
  createTimelineSelectionFromClipIds,
  createPointTimelineSelection,
  getDefaultSelectionEnd,
} from "./utils/createTimelineSelection";
export type { CreateTimelineSelectionFromClipIdsOptions } from "./utils/createTimelineSelection";
export { getTimelineSelectionFromAsset } from "./utils/assetSelection";
export {
  selectionToCompositeContent,
  renamespaceCompositeContentTracks,
  compositeContentToSelection,
  hashCompositeContent,
} from "./utils/composite";
