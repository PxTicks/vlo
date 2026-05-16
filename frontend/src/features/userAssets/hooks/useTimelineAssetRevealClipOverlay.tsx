import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ImageSearchIcon from "@mui/icons-material/ImageSearch";
import { Box } from "@mui/material";
import { styled } from "@mui/material/styles";
import { isAssetBackedClip } from "../../../types/TimelineTypes";
import {
  createEndpointOverlayItem,
  type TimelineClipOverlayDefinition,
  useTimelineStore,
} from "../../timeline";
import { revealAssetInBrowser } from "../useAssetBrowserRevealStore";
import { useAssetStore } from "../useAssetStore";
import { getAdjacentFamilyMemberForAsset } from "../utils/familyMembers";

const RevealAssetBadge = styled(Box)({
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
    backgroundColor: "rgba(77, 171, 245, 0.82)",
    borderColor: "rgba(255, 255, 255, 0.38)",
  },
});

const FamilySwapBadge = styled(RevealAssetBadge)({
  width: 16,
  height: 16,
});

function useAssetRevealOverlayItems({
  clip,
}: Parameters<TimelineClipOverlayDefinition["useItems"]>[0]) {
  const assets = useAssetStore((state) => state.assets);
  const families = useAssetStore((state) => state.families);

  if (!isAssetBackedClip(clip)) {
    return [];
  }
  const assetId = clip.assetId;

  const asset = assets.find((candidate) => candidate.id === assetId);
  if (!asset) {
    return [];
  }

  const previousAsset = getAdjacentFamilyMemberForAsset(
    assets,
    families,
    asset,
    "previous",
  );
  const nextAsset = getAdjacentFamilyMemberForAsset(
    assets,
    families,
    asset,
    "next",
  );
  const hasFamilyNavigation =
    previousAsset !== null &&
    nextAsset !== null &&
    previousAsset.id !== asset.id &&
    nextAsset.id !== asset.id;

  const items = [
    createEndpointOverlayItem({
      id: `reveal-asset:${clip.id}`,
      edge: "end",
      lane: "bottom",
      insetPx: hasFamilyNavigation ? 8 : 28,
      minClipWidthPx: 56,
      order: hasFamilyNavigation ? 1 : 0,
      content: (
        <RevealAssetBadge title="Reveal asset in browser">
          <ImageSearchIcon sx={{ fontSize: 13 }} />
        </RevealAssetBadge>
      ),
      onClick: () => {
        revealAssetInBrowser(assetId);
      },
    }),
  ];

  if (!hasFamilyNavigation) {
    return items;
  }

  items.push(
    createEndpointOverlayItem({
      id: `swap-family-next:${clip.id}`,
      edge: "end",
      lane: "bottom",
      insetPx: 8,
      minClipWidthPx: 56,
      order: 0,
      content: (
        <FamilySwapBadge title={`Swap to ${nextAsset.name}`}>
          <ChevronRightIcon sx={{ fontSize: 12 }} />
        </FamilySwapBadge>
      ),
      onClick: () => {
        useTimelineStore.getState().replaceClipAsset(clip.id, nextAsset);
      },
    }),
    createEndpointOverlayItem({
      id: `swap-family-previous:${clip.id}`,
      edge: "end",
      lane: "bottom",
      minClipWidthPx: 56,
      order: 2,
      content: (
        <FamilySwapBadge title={`Swap to ${previousAsset.name}`}>
          <ChevronLeftIcon sx={{ fontSize: 12 }} />
        </FamilySwapBadge>
      ),
      onClick: () => {
        useTimelineStore.getState().replaceClipAsset(clip.id, previousAsset);
      },
    }),
  );

  return items;
}

const TIMELINE_ASSET_REVEAL_CLIP_OVERLAY: TimelineClipOverlayDefinition = {
  id: "timeline-asset-reveal-overlay",
  useItems: useAssetRevealOverlayItems,
};

export function useTimelineAssetRevealClipOverlay(): TimelineClipOverlayDefinition {
  return TIMELINE_ASSET_REVEAL_CLIP_OVERLAY;
}
