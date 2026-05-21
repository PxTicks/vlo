export {
  bakeCompositeProxy,
  type BakeCompositeProxyOptions,
  type BakedCompositeProxy,
} from "./services/bakeCompositeProxy";
export { CompositePanel } from "./CompositePanel";
export { useTimelineCompositeRenderStatusOverlay } from "./hooks/useTimelineCompositeRenderStatusOverlay";
export {
  groupSelectionIntoComposite,
  type GroupSelectionOptions,
} from "./services/groupSelectionIntoComposite";
export {
  renderCompositeProxyForClip,
  scheduleCompositeProxyRender,
} from "./services/renderCompositeProxyForClip";
export {
  rebakeCompositeClip,
  applyCompositeContentEdit,
} from "./services/rebakeCompositeClip";
export {
  beginCompositeRender,
  endCompositeRender,
  useCompositeRenderStatusStore,
  useIsCompositeRendering,
} from "./useCompositeRenderStatusStore";
export { useCompositeTimelineStore } from "./useCompositeTimelineStore";
export { createCompositeTimelineClip } from "./utils/createCompositeClip";
