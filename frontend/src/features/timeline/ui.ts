// Timeline UI surface: the rendered timeline and its UI-only hooks/components.
//
// This is deliberately separate from `./index` (state, selectors, edit
// commands, primitives). `TimelineContainer` pulls in feature UIs (composite,
// SAM audio, transformations, user assets), so re-exporting it from the API
// barrel would drag every API consumer into the timeline UI import cycle.
// Only the editor/app shell should import from here.
export { TimelineContainer as Timeline } from "./TimelineContainer";
export type { TimelineContainerProps } from "./TimelineContainer";
export { AssetDragOverlay } from "./components/AssetDragOverlay";
export { useAssetDrag } from "./hooks/dnd/useAssetDrag";
export { useTimelineClipMuteOverlay } from "./hooks/useTimelineClipMuteOverlay";
export { useTimelineMarkersClipOverlay } from "./hooks/useTimelineMarkersClipOverlay";
export { useTimelineReverseStatusOverlay } from "./hooks/useTimelineReverseStatusOverlay";
