import React, { useState } from "react";
import {
  Box,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Typography,
} from "@mui/material";
import { styled } from "@mui/material/styles";
import { useDraggable } from "@dnd-kit/core";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import PauseCircleOutlineIcon from "@mui/icons-material/PauseCircleOutline";
import DeleteIcon from "@mui/icons-material/Delete";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import ReplayIcon from "@mui/icons-material/Replay";
import TimelineIcon from "@mui/icons-material/Timeline";
import type { Asset } from "../../../types/Asset";
import {
  createClipFromAsset,
  insertAssetAtTime,
  useTimelineClipCountForAsset,
} from "../../timeline";
import { useGenerationStore } from "../../generation/useGenerationStore";
import { getTimelineSelectionFromAsset } from "../../timelineSelection";
import { useAssetStore } from "../useAssetStore";
import { AssetPreviewDialog } from "./AssetPreviewDialog";

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

const StyledActionButton = styled(IconButton)({
  position: "absolute",
  top: 4,
  right: 4,
  backgroundColor: "rgba(0, 0, 0, 0.5)",
  color: "white",
  padding: 4,
  "&:hover": {
    backgroundColor: "rgba(0, 0, 0, 0.75)",
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

function canRegenerateFromMetadata(asset: Asset): boolean {
  const metadata = asset.creationMetadata;
  return (
    metadata?.source === "generated" &&
    Boolean(metadata.comfyuiPrompt || metadata.comfyuiWorkflow)
  );
}

function AssetCardComponent({ asset }: AssetCardProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);

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
    e.stopPropagation();

    if (asset.type === "video") {
      setIsPreviewOpen(true);
      return;
    }

    if (asset.type === "audio") {
      setIsPlaying((prev) => !prev);
    }
  };

  const deleteAsset = useAssetStore((state) => state.deleteAsset);
  const timelineClipCount = useTimelineClipCountForAsset(asset.id);
  const timelineSelection = getTimelineSelectionFromAsset(asset);
  const canRegenerate = canRegenerateFromMetadata(asset);
  const isMenuOpen = Boolean(menuAnchorEl);

  function handleOpenMenu(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    event.preventDefault();
    setMenuAnchorEl(event.currentTarget);
  }

  function handleCloseMenu() {
    setMenuAnchorEl(null);
  }

  function handleDelete() {
    handleCloseMenu();
    const confirmMessage =
      timelineClipCount > 0
        ? "Are you sure you want to delete this asset? This will remove it from disk permanently.\n\nThis asset is used by clips on the Timeline.\nClips on the Timeline are derived from the asset and will be deleted."
        : "Are you sure you want to delete this asset? This will remove it from disk permanently.";

    if (window.confirm(confirmMessage)) {
      void deleteAsset(asset.id);
    }
  }

  function handleSendToTimeline() {
    handleCloseMenu();
    if (!timelineSelection) {
      return;
    }

    insertAssetAtTime(asset, timelineSelection.start);
  }

  async function handleRegenerate() {
    handleCloseMenu();

    try {
      await useGenerationStore.getState().loadWorkflowFromAssetMetadata(asset);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to load workflow metadata";
      window.alert(message);
    }
  }

  return (
    <>
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
          {displayImage ? (
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
            <OverlayControls isPlaying={asset.type === "audio" && isPlaying}>
              <IconButton
                onClick={handlePlayToggle}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label={
                  asset.type === "video"
                    ? "Preview video"
                    : isPlaying
                      ? "Pause audio"
                      : "Play audio"
                }
                sx={{ color: "white" }}
              >
                {asset.type === "audio" && isPlaying ? (
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

        <StyledActionButton
          size="small"
          onClick={handleOpenMenu}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Asset actions"
          title="Asset actions"
        >
          <MoreVertIcon fontSize="small" />
        </StyledActionButton>
        <Menu
          anchorEl={menuAnchorEl}
          open={isMenuOpen}
          onClose={handleCloseMenu}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
          onClick={(event) => event.stopPropagation()}
        >
          {canRegenerate ? (
            <MenuItem onClick={() => void handleRegenerate()}>
              <ListItemIcon>
                <ReplayIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Regenerate</ListItemText>
            </MenuItem>
          ) : null}
          {timelineSelection ? (
            <MenuItem onClick={handleSendToTimeline}>
              <ListItemIcon>
                <TimelineIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Send to Timeline</ListItemText>
            </MenuItem>
          ) : null}
          <MenuItem onClick={handleDelete}>
            <ListItemIcon>
              <DeleteIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Delete</ListItemText>
          </MenuItem>
        </Menu>

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

      {asset.type === "video" ? (
        <AssetPreviewDialog
          asset={asset}
          open={isPreviewOpen}
          onClose={() => setIsPreviewOpen(false)}
        />
      ) : null}
    </>
  );
}

export const AssetCard = React.memo(AssetCardComponent);
