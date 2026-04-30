import { useMemo } from "react";
import { Box } from "@mui/material";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import type { TimelineClipOverlayDefinition } from "../clipOverlayApi";
import { createEndpointOverlayItem } from "../clipOverlayApi";
import type { TimelineClip } from "../../../types/TimelineTypes";

function MuteIndicator() {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 16,
        height: 16,
        borderRadius: "50%",
        bgcolor: "#dc2626",
        color: "#fff",
        boxShadow: "0 0 0 1px rgba(0,0,0,0.4)",
        pointerEvents: "none",
      }}
    >
      <VolumeOffIcon sx={{ fontSize: 12 }} />
    </Box>
  );
}

function isClipMuted(clip: TimelineClip): boolean {
  return clip.type !== "mask" && clip.isMuted === true;
}

function useClipMuteOverlayItems({ clip }: { clip: TimelineClip }) {
  const muted = isClipMuted(clip);
  return useMemo(() => {
    if (!muted) return [];
    return [
      createEndpointOverlayItem({
        id: "clip-mute-indicator",
        edge: "end",
        lane: "top",
        insetPx: 4,
        content: <MuteIndicator />,
      }),
    ];
  }, [muted]);
}

const TIMELINE_CLIP_MUTE_OVERLAY: TimelineClipOverlayDefinition = {
  id: "timeline-clip-mute-overlay",
  useItems: useClipMuteOverlayItems,
};

export function useTimelineClipMuteOverlay(): TimelineClipOverlayDefinition {
  return TIMELINE_CLIP_MUTE_OVERLAY;
}
