import { useMemo } from "react";
import { Box } from "@mui/material";
import FastRewindIcon from "@mui/icons-material/FastRewind";
import type { TimelineClipOverlayDefinition } from "../clipOverlayApi";
import { createEndpointOverlayItem } from "../clipOverlayApi";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { useIsClipReversing } from "./useClipReversalStore";

function useReverseStatusOverlayItems({ clip }: { clip: TimelineClip }) {
  const isReversing = useIsClipReversing(clip.id);
  return useMemo(() => {
    if (!isReversing) return [];
    return [
      createEndpointOverlayItem({
        id: "clip-reverse-status",
        edge: "start",
        lane: "middle",
        insetPx: 4,
        content: (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              px: 0.75,
              height: 18,
              borderRadius: "9px",
              bgcolor: "rgba(17,24,39,0.85)",
              color: "#fff",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
              boxShadow: "0 0 0 1px rgba(255,255,255,0.2)",
              pointerEvents: "none",
            }}
          >
            <FastRewindIcon
              sx={{
                fontSize: 12,
                animation: "clip-reverse-pulse 1s ease-in-out infinite",
                "@keyframes clip-reverse-pulse": {
                  "0%, 100%": { opacity: 0.4 },
                  "50%": { opacity: 1 },
                },
              }}
            />
            Rendering reverse…
          </Box>
        ),
      }),
    ];
  }, [isReversing]);
}

const TIMELINE_REVERSE_STATUS_OVERLAY: TimelineClipOverlayDefinition = {
  id: "timeline-clip-reverse-status-overlay",
  useItems: useReverseStatusOverlayItems,
};

export function useTimelineReverseStatusOverlay(): TimelineClipOverlayDefinition {
  return TIMELINE_REVERSE_STATUS_OVERLAY;
}
