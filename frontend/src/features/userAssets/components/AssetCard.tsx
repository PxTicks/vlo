import React, { useState, useRef } from "react";
import { Box, Typography, Paper, IconButton } from "@mui/material";
import { styled } from "@mui/material/styles";
import { useDraggable } from "@dnd-kit/core";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import PauseCircleOutlineIcon from "@mui/icons-material/PauseCircleOutline";
import DeleteIcon from "@mui/icons-material/Delete";
import type { Asset } from "../../../types/Asset";
import {
  createClipFromAsset,
  useTimelineClipCountForAsset,
} from "../../timeline";
import { useAssetStore } from "../useAssetStore";

interface AssetCardProps {
  asset: Asset;
}

// Styled Components for better performance
const StyledCard = styled(Paper, {
  shouldForwardProp: (prop) => prop !== "isDragging",
})<{ isDragging?: boolean }>(({ isDragging }) => ({
  width: "100%",
  backgroundColor: "#252525",
  color: "white",
  overflow: "hidden",
  cursor: "grab",
  transition: "transform 0.1s",
  "&:hover": { transform: "scale(1.02)" },
  position: "relative",
  opacity: isDragging ? 0.5 : 1,
}));

const ThumbnailContainer = styled(Box)({
  height: 80,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "#000",
  position: "relative",
});

const OverlayControls = styled(Box, {
  shouldForwardProp: (prop) => prop !== "isPlaying",
})<{ isPlaying: boolean }>(({ isPlaying }) => ({
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: isPlaying ? "transparent" : "rgba(0,0,0,0.3)",
  opacity: isPlaying ? 0 : 1,
  transition: "opacity 0.2s",
  "&:hover": { opacity: 1 },
}));

const DurationBadge = styled(Box)({
  position: "absolute",
  bottom: 4,
  right: 4,
  backgroundColor: "rgba(0, 0, 0, 0.7)",
  paddingLeft: 4,
  paddingRight: 4,
  borderRadius: 2,
  pointerEvents: "none",
});

const StyledDeleteButton = styled(IconButton)({
  position: "absolute",
  top: 4,
  right: 4,
  backgroundColor: "rgba(0, 0, 0, 0.5)",
  color: "white",
  padding: 4,
  "&:hover": {
    backgroundColor: "rgba(200, 0, 0, 0.8)",
  },
  zIndex: 10,
});

// Helper to format seconds into MM:SS
const formatDuration = (seconds?: number) => {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

function AssetCardComponent({ asset }: AssetCardProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const draggableData = React.useMemo(
    () => ({
      type: "asset",
      clip: createClipFromAsset(asset),
      asset, // PASS ASSET FOR OVERLAY
    }),
    [asset],
  );

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `asset_${asset.id}`,
    data: draggableData,
  });

  const displayImage =
    asset.thumbnail || (asset.type === "image" ? asset.src : null);

  const handlePlayToggle = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent drag events if nested
    setIsPlaying((prev) => !prev);
  };

  const deleteAsset = useAssetStore((state) => state.deleteAsset);
  const timelineClipCount = useTimelineClipCountForAsset(asset.id);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const confirmMessage =
      timelineClipCount > 0
        ? "Are you sure you want to delete this asset? This will remove it from disk permanently.\n\nThis asset is used by clips on the Timeline.\nClips on the Timeline are derived from the asset and will be deleted."
        : "Are you sure you want to delete this asset? This will remove it from disk permanently.";

    if (
      window.confirm(confirmMessage)
    ) {
      deleteAsset(asset.id);
    }
  };

  return (
    <StyledCard
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      elevation={2}
      isDragging={isDragging}
      onMouseLeave={() => setIsPlaying(false)}
      data-testid="asset-card"
    >
      {/* Thumbnail / Video Area */}
      <ThumbnailContainer>
        {isPlaying && asset.type === "video" ? (
          <video
            ref={videoRef}
            src={asset.src}
            autoPlay
            muted={false} // User likely wants to hear it
            controls={false} // Clean look, click to stop
            loop
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        ) : displayImage ? (
          <img
            src={displayImage}
            alt={asset.name}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "100%",
              height: "100%",
            }}
          >
            {asset.type === "audio" ? (
              <MusicNoteIcon sx={{ fontSize: 40, color: "#888" }} />
            ) : (
              <Typography variant="caption" sx={{ color: "#555" }}>
                No Preview
              </Typography>
            )}
          </Box>
        )}

        {/* Audio Player */}
        {isPlaying && asset.type === "audio" && (
          <audio src={asset.src} autoPlay loop />
        )}

        {/* Video/Audio Overlay Controls */}
        {(asset.type === "video" || asset.type === "audio") && (
          <OverlayControls isPlaying={isPlaying}>
            <IconButton
              onClick={handlePlayToggle}
              onPointerDown={(e) => e.stopPropagation()}
              sx={{ color: "white" }}
            >
              {isPlaying ? (
                <PauseCircleOutlineIcon sx={{ fontSize: 32 }} />
              ) : (
                <PlayCircleOutlineIcon sx={{ fontSize: 32 }} />
              )}
            </IconButton>
          </OverlayControls>
        )}

        {/* Duration Badge */}
        {asset.type !== "image" && asset.duration && (
          <DurationBadge>
            <Typography
              variant="caption"
              sx={{ fontSize: "0.6rem", color: "white" }}
            >
              {formatDuration(asset.duration)}
            </Typography>
          </DurationBadge>
        )}
      </ThumbnailContainer>

      <StyledDeleteButton
        size="small"
        onClick={handleDelete}
        onPointerDown={(e) => e.stopPropagation()}
        title="Delete Asset"
      >
        <DeleteIcon fontSize="small" />
      </StyledDeleteButton>

      {/* Metadata Area */}
      <Box sx={{ p: 1 }}>
        <Typography
          variant="caption"
          noWrap
          display="block"
          sx={{ fontWeight: 500 }}
          title={asset.name} // Tooltip for long names
        >
          {asset.name}
        </Typography>
        <Typography
          variant="caption"
          display="block"
          sx={{ fontSize: "0.65rem", color: "#aaa" }}
        >
          {asset.createdAt
            ? new Date(asset.createdAt).toLocaleTimeString()
            : "Unknown Time"}
          {/* Fallback added in case createdAt is missing in legacy data */}
        </Typography>
      </Box>
    </StyledCard>
  );
}

export const AssetCard = React.memo(AssetCardComponent);
