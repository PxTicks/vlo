import ImageSearchIcon from "@mui/icons-material/ImageSearch";
import { Box } from "@mui/material";
import { styled } from "@mui/material/styles";
import type { TimelineClipOverlayDefinition } from "../../timeline/clipOverlayApi";
import { createEndpointOverlayItem } from "../../timeline/clipOverlayApi";
import { isCompositeClip } from "../../../types/TimelineTypes";
import { revealCompositeInBrowser } from "../useCompositeLibraryStore";

const RevealCompositeBadge = styled(Box)({
  width: 18,
  height: 18,
  borderRadius: 999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#f3f4f6",
  backgroundColor: "rgba(12, 12, 12, 0.72)",
  border: "1px solid rgba(255, 255, 255, 0.18)",
  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.45)",
  transition: "background-color 0.12s ease, border-color 0.12s ease",
  "&:hover": {
    backgroundColor: "rgba(124, 58, 237, 0.82)",
    borderColor: "rgba(255, 255, 255, 0.38)",
  },
});

function useCompositeRevealOverlayItems({
  clip,
}: Parameters<TimelineClipOverlayDefinition["useItems"]>[0]) {
  if (!isCompositeClip(clip)) {
    return [];
  }
  const compositeAssetId = clip.compositeId;

  return [
    createEndpointOverlayItem({
      id: `reveal-composite:${clip.id}`,
      edge: "end",
      lane: "bottom",
      insetPx: 28,
      minClipWidthPx: 56,
      content: (
        <RevealCompositeBadge title="Reveal composite in browser">
          <ImageSearchIcon sx={{ fontSize: 13 }} />
        </RevealCompositeBadge>
      ),
      onClick: () => {
        revealCompositeInBrowser(compositeAssetId);
      },
    }),
  ];
}

const TIMELINE_COMPOSITE_REVEAL_CLIP_OVERLAY: TimelineClipOverlayDefinition = {
  id: "timeline-composite-reveal-overlay",
  useItems: useCompositeRevealOverlayItems,
};

export function useTimelineCompositeRevealClipOverlay(): TimelineClipOverlayDefinition {
  return TIMELINE_COMPOSITE_REVEAL_CLIP_OVERLAY;
}
