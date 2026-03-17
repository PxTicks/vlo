import { memo, useRef } from "react";
import { styled } from "@mui/material/styles";
import { useTimelineViewStore } from "../hooks/useTimelineViewStore";
import { CLIP_HEIGHT } from "../constants";
import type { BaseClip } from "../../../types/TimelineTypes";
import { useThumbnailRenderer } from "../hooks/useThumbnailRenderer";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import { useAsset } from "../../userAssets";
import { Box } from "@mui/material";

const StyledCanvas = styled("canvas")({
  position: "absolute",
  top: 0,
  left: 0,
  pointerEvents: "none",
  zIndex: 0,
  // Ensure no CSS interferes with the internal width/height
  width: "auto",
  height: "auto",
});

const AudioIconOverlay = styled(Box)({
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
  zIndex: 1,
});

interface ThumbnailCanvasProps {
  clip: BaseClip;
  isDragging?: boolean;
}

export function ThumbnailCanvasBase({
  clip,
  isDragging,
}: ThumbnailCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const zoomScale = useTimelineViewStore((state) => state.zoomScale);

  const assetType = useAsset(clip.assetId)?.type;

  // We still calculate height to pass to the renderer logic,
  // but we do NOT pass dimensions to the DOM element here.
  const height = CLIP_HEIGHT - 2;

  useThumbnailRenderer({
    canvasRef,
    clip,
    zoomScale,
    height,
    enabled: true,
    isDragging,
  });

  return (
    <>
      <StyledCanvas
        ref={canvasRef}
        id={`thumbnail-canvas-${clip.id}`}
        // REMOVED: width={fullWidth} -> This was the primary cause of the glitch
        // REMOVED: height={height} -> Let the hook manage this
      />
      {assetType === "audio" && (
        <AudioIconOverlay>
          <MusicNoteIcon sx={{ fontSize: 40, color: "#888" }} />
        </AudioIconOverlay>
      )}
    </>
  );
}

export const ThumbnailCanvas = memo(ThumbnailCanvasBase);
