import { useMemo, useSyncExternalStore } from "react";
import {
  useTimelineClipMuteOverlay,
  useTimelineMarkersClipOverlay,
  useTimelineReverseStatusOverlay,
} from "../../features/timeline/ui";
import type { TimelineClipOverlayDefinition } from "../../features/timeline";
import { useTimelineKeyframeClipOverlay } from "../../features/transformations";
import { useTimelineAssetRevealClipOverlay } from "../../features/userAssets";
import {
  useTimelineCompositeRevealClipOverlay,
  useTimelineCompositeRenderStatusOverlay,
} from "../../features/composite";
import { extensionClipOverlayRegistry } from "../../features/extensions/timeline/ExtensionClipOverlayRegistry";

export function useEditorClipOverlays(): readonly TimelineClipOverlayDefinition[] {
  const keyframeClipOverlay = useTimelineKeyframeClipOverlay();
  const assetRevealClipOverlay = useTimelineAssetRevealClipOverlay();
  const muteClipOverlay = useTimelineClipMuteOverlay();
  const markersClipOverlay = useTimelineMarkersClipOverlay();
  const reverseStatusClipOverlay = useTimelineReverseStatusOverlay();
  const compositeRenderStatusClipOverlay =
    useTimelineCompositeRenderStatusOverlay();
  const compositeRevealClipOverlay = useTimelineCompositeRevealClipOverlay();

  // Extension-registered overlays share the same hot render path as built-in
  // overlays; re-derive when the owner-scoped registry changes.
  const extensionOverlayRevision = useSyncExternalStore(
    (listener) => extensionClipOverlayRegistry.subscribe(listener),
    () => extensionClipOverlayRegistry.getRevision(),
    () => extensionClipOverlayRegistry.getRevision(),
  );

  return useMemo(
    () => [
      keyframeClipOverlay,
      assetRevealClipOverlay,
      compositeRevealClipOverlay,
      muteClipOverlay,
      markersClipOverlay,
      reverseStatusClipOverlay,
      compositeRenderStatusClipOverlay,
      ...extensionClipOverlayRegistry
        .list()
        .map((contribution) => contribution.definition.overlay),
    ],
    [
      assetRevealClipOverlay,
      compositeRevealClipOverlay,
      compositeRenderStatusClipOverlay,
      keyframeClipOverlay,
      markersClipOverlay,
      muteClipOverlay,
      reverseStatusClipOverlay,
      extensionOverlayRevision,
    ],
  );
}
