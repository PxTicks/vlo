import { useMemo } from "react";
import { Box, IconButton, Tooltip } from "@mui/material";
import LayersIcon from "@mui/icons-material/Layers";
import RefreshIcon from "@mui/icons-material/Refresh";
import SensorsIcon from "@mui/icons-material/Sensors";
import type { TimelineClipOverlayDefinition } from "../../timeline/clipOverlayApi";
import { createEndpointOverlayItem } from "../../timeline/clipOverlayApi";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { isCompositeClip } from "../../../types/TimelineTypes";
import {
  setCompositeForceLive,
  useCompositeBakeRuntimeStatus,
  useCompositeDirectRenderError,
  useIsCompositeForceLive,
  useIsCompositeRendering,
} from "../useCompositeRenderStatusStore";
import { useCompositeLibraryStore } from "../useCompositeLibraryStore";

function useCompositeRenderStatusOverlayItems({ clip }: { clip: TimelineClip }) {
  const compositeId = isCompositeClip(clip) ? clip.compositeId : undefined;
  const composite = useCompositeLibraryStore((state) =>
    compositeId
      ? state.composites.find((candidate) => candidate.id === compositeId)
      : undefined,
  );
  const retryCompositeBake = useCompositeLibraryStore(
    (state) => state.retryCompositeBake,
  );
  const isRendering = useIsCompositeRendering(
    compositeId,
  );
  const bakeRuntime = useCompositeBakeRuntimeStatus(compositeId);
  const forceLive = useIsCompositeForceLive(compositeId);
  const directRenderError = useCompositeDirectRenderError(
    isCompositeClip(clip) ? clip.id : undefined,
  );
  return useMemo(() => {
    const bakeFailed = composite?.bake?.status === "failed";
    if (
      (!isRendering &&
        !bakeRuntime &&
        !directRenderError &&
        !bakeFailed &&
        !forceLive) ||
      !isCompositeClip(clip)
    ) {
      return [];
    }
    const label = directRenderError
      ? "Direct render failed"
      : bakeFailed
        ? "Bake failed"
        : bakeRuntime?.status === "rendering"
          ? `Baking ${Math.round(bakeRuntime.progress)}%`
          : forceLive
            ? "Live"
            : "Bake queued";
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
              bgcolor: directRenderError
                ? "rgba(127,29,29,0.92)"
                : "rgba(17,24,39,0.85)",
              color: "#fff",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
              boxShadow: "0 0 0 1px rgba(255,255,255,0.2)",
              pointerEvents: "auto",
            }}
          >
            <LayersIcon
              sx={{
                fontSize: 12,
                animation: directRenderError
                  ? undefined
                  : "clip-composite-pulse 1s ease-in-out infinite",
                "@keyframes clip-composite-pulse": {
                  "0%, 100%": { opacity: 0.4 },
                  "50%": { opacity: 1 },
                },
              }}
            />
            {label}
            {bakeFailed ? (
              <Tooltip title="Retry background bake">
                <IconButton
                  size="small"
                  aria-label="Retry composite bake"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    void retryCompositeBake(clip.compositeId);
                  }}
                  sx={{ p: 0.1, color: "#fff" }}
                >
                  <RefreshIcon sx={{ fontSize: 12 }} />
                </IconButton>
              </Tooltip>
            ) : null}
            <Tooltip title={forceLive ? "Use automatic source policy" : "Force live rendering"}>
              <IconButton
                size="small"
                aria-label={forceLive ? "Use automatic composite source" : "Force live composite rendering"}
                aria-pressed={forceLive}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setCompositeForceLive(clip.compositeId, !forceLive);
                }}
                sx={{ p: 0.1, color: forceLive ? "#86efac" : "#fff" }}
              >
                <SensorsIcon sx={{ fontSize: 12 }} />
              </IconButton>
            </Tooltip>
          </Box>
        ),
      }),
    ];
  }, [
    bakeRuntime,
    clip,
    composite?.bake?.status,
    directRenderError,
    forceLive,
    isRendering,
    retryCompositeBake,
  ]);
}

const TIMELINE_COMPOSITE_RENDER_STATUS_OVERLAY: TimelineClipOverlayDefinition = {
  id: "timeline-clip-composite-render-status-overlay",
  useItems: useCompositeRenderStatusOverlayItems,
};

export function useTimelineCompositeRenderStatusOverlay(): TimelineClipOverlayDefinition {
  return TIMELINE_COMPOSITE_RENDER_STATUS_OVERLAY;
}
