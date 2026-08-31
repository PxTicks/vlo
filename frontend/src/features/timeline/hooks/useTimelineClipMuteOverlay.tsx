import { useMemo } from "react";
import { Box } from "@mui/material";
import { styled } from "@mui/material/styles";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import type { TimelineClipOverlayDefinition } from "../clipOverlayApi";
import { createEndpointOverlayItem } from "../clipOverlayApi";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { isAssetBackedClip } from "../../../types/TimelineTypes";
import { useAsset } from "../../userAssets/api";
import { toggleTimelineClipMute } from "../api";

const MuteToggleBadge = styled(Box, {
  shouldForwardProp: (prop) => prop !== "muted",
})<{ muted: boolean }>(({ muted }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 16,
  height: 16,
  borderRadius: "50%",
  cursor: "pointer",
  color: "#fff",
  backgroundColor: muted ? "#dc2626" : "rgba(12, 12, 12, 0.72)",
  border: muted
    ? "1px solid rgba(0, 0, 0, 0.4)"
    : "1px solid rgba(255, 255, 255, 0.18)",
  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.45)",
  transition: "background-color 0.12s ease, border-color 0.12s ease",
  "&:hover": {
    backgroundColor: muted ? "#ef4444" : "rgba(77, 171, 245, 0.82)",
    borderColor: "rgba(255, 255, 255, 0.38)",
  },
}));

function isClipMuted(clip: TimelineClip): boolean {
  return clip.type !== "mask" && clip.isMuted === true;
}

function useClipMuteOverlayItems({ clip }: { clip: TimelineClip }) {
  // Video clips only carry audio when their asset does; audio clips always do.
  // Hooks stay unconditional, so the lookup runs for every clip type.
  const asset = useAsset(isAssetBackedClip(clip) ? clip.assetId : undefined);
  const muted = isClipMuted(clip);
  const audible =
    clip.type === "audio" ||
    (clip.type === "video" && asset?.hasAudio !== false);
  // An already-muted clip keeps its toggle even if it reads as silent, so the
  // state stays reversible.
  const visible = audible || muted;
  const clipId = clip.id;

  return useMemo(() => {
    if (!visible) return [];
    return [
      createEndpointOverlayItem({
        id: "clip-mute-toggle",
        edge: "end",
        lane: "top",
        insetPx: 4,
        content: (
          <MuteToggleBadge muted={muted} title={muted ? "Unmute" : "Mute"}>
            {muted ? (
              <VolumeOffIcon sx={{ fontSize: 12 }} />
            ) : (
              <VolumeUpIcon sx={{ fontSize: 12 }} />
            )}
          </MuteToggleBadge>
        ),
        onClick: () => {
          toggleTimelineClipMute(clipId);
        },
      }),
    ];
  }, [clipId, muted, visible]);
}

const TIMELINE_CLIP_MUTE_OVERLAY: TimelineClipOverlayDefinition = {
  id: "timeline-clip-mute-overlay",
  useItems: useClipMuteOverlayItems,
};

export function useTimelineClipMuteOverlay(): TimelineClipOverlayDefinition {
  return TIMELINE_CLIP_MUTE_OVERLAY;
}
