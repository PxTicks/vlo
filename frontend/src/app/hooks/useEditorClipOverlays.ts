import { useMemo } from "react";
import {
  useTimelineClipMuteOverlay,
  useTimelineMarkersClipOverlay,
} from "../../features/timeline";
import type { TimelineClipOverlayDefinition } from "../../features/timeline";
import { useTimelineKeyframeClipOverlay } from "../../features/transformations";
import { useTimelineAssetRevealClipOverlay } from "../../features/userAssets";

export function useEditorClipOverlays(): readonly TimelineClipOverlayDefinition[] {
  const keyframeClipOverlay = useTimelineKeyframeClipOverlay();
  const assetRevealClipOverlay = useTimelineAssetRevealClipOverlay();
  const muteClipOverlay = useTimelineClipMuteOverlay();
  const markersClipOverlay = useTimelineMarkersClipOverlay();

  return useMemo(
    () => [
      keyframeClipOverlay,
      assetRevealClipOverlay,
      muteClipOverlay,
      markersClipOverlay,
    ],
    [
      assetRevealClipOverlay,
      keyframeClipOverlay,
      markersClipOverlay,
      muteClipOverlay,
    ],
  );
}
