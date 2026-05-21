import { useMemo } from "react";
import { Box } from "@mui/material";
import LayersIcon from "@mui/icons-material/Layers";
import type { TimelineClipOverlayDefinition } from "../../timeline/clipOverlayApi";
import { createEndpointOverlayItem } from "../../timeline/clipOverlayApi";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { useIsCompositeRendering } from "../useCompositeRenderStatusStore";

function useCompositeRenderStatusOverlayItems({ clip }: { clip: TimelineClip }) {
  const isRendering = useIsCompositeRendering(clip.id);
  return useMemo(() => {
    if (!isRendering || clip.type !== "composite") return [];
    return [
      createEndpointOverlayItem({
        id: "clip-composite-render-status",
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
            <LayersIcon
              sx={{
                fontSize: 12,
                animation: "clip-composite-pulse 1s ease-in-out infinite",
                "@keyframes clip-composite-pulse": {
                  "0%, 100%": { opacity: 0.4 },
                  "50%": { opacity: 1 },
                },
              }}
            />
            Rendering…
          </Box>
        ),
      }),
    ];
  }, [clip.type, isRendering]);
}

const TIMELINE_COMPOSITE_RENDER_STATUS_OVERLAY: TimelineClipOverlayDefinition = {
  id: "timeline-clip-composite-render-status-overlay",
  useItems: useCompositeRenderStatusOverlayItems,
};

export function useTimelineCompositeRenderStatusOverlay(): TimelineClipOverlayDefinition {
  return TIMELINE_COMPOSITE_RENDER_STATUS_OVERLAY;
}
