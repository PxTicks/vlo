import { useMemo } from "react";
import {
  useTimelineClipMuteOverlay,
  useTimelineMarkersClipOverlay,
  useTimelineReverseStatusOverlay,
} from "../../features/timeline";
import type { TimelineClipOverlayDefinition } from "../../features/timeline";
import { useTimelineKeyframeClipOverlay } from "../../features/transformations";
import { useTimelineAssetRevealClipOverlay } from "../../features/userAssets";

export function useEditorClipOverlays(): readonly TimelineClipOverlayDefinition[] {
  const keyframeClipOverlay = useTimelineKeyframeClipOverlay();
  const assetRevealClipOverlay = useTimelineAssetRevealClipOverlay();
  const muteClipOverlay = useTimelineClipMuteOverlay();
  const markersClipOverlay = useTimelineMarkersClipOverlay();
  const reverseStatusClipOverlay = useTimelineReverseStatusOverlay();

  return useMemo(
    () => [
      keyframeClipOverlay,
      assetRevealClipOverlay,
      muteClipOverlay,
      markersClipOverlay,
      reverseStatusClipOverlay,
    ],
    [
      assetRevealClipOverlay,
      keyframeClipOverlay,
      markersClipOverlay,
      muteClipOverlay,
      reverseStatusClipOverlay,
    ],
  );
}
