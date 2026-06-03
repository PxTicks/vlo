import { useMemo } from "react";
import {
  useTimelineClipMuteOverlay,
  useTimelineMarkersClipOverlay,
  useTimelineReverseStatusOverlay,
} from "../../features/timeline";
import type { TimelineClipOverlayDefinition } from "../../features/timeline";
import { useTimelineKeyframeClipOverlay } from "../../features/transformations";
import { useTimelineAssetRevealClipOverlay } from "../../features/userAssets";
import { useTimelineCompositeRenderStatusOverlay } from "../../features/composite";

export function useEditorClipOverlays(): readonly TimelineClipOverlayDefinition[] {
  const keyframeClipOverlay = useTimelineKeyframeClipOverlay();
  const assetRevealClipOverlay = useTimelineAssetRevealClipOverlay();
  const muteClipOverlay = useTimelineClipMuteOverlay();
  const markersClipOverlay = useTimelineMarkersClipOverlay();
  const reverseStatusClipOverlay = useTimelineReverseStatusOverlay();
  const compositeRenderStatusClipOverlay =
    useTimelineCompositeRenderStatusOverlay();

  return useMemo(
    () => [
      keyframeClipOverlay,
      assetRevealClipOverlay,
      muteClipOverlay,
      markersClipOverlay,
      reverseStatusClipOverlay,
      compositeRenderStatusClipOverlay,
    ],
    [
      assetRevealClipOverlay,
      compositeRenderStatusClipOverlay,
      keyframeClipOverlay,
      markersClipOverlay,
      muteClipOverlay,
      reverseStatusClipOverlay,
    ],
  );
}
