import { memo, type MouseEvent } from "react";
import { useDraggable } from "@dnd-kit/core";
import {
  Box,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import AddToTimelineIcon from "@mui/icons-material/PlaylistAdd";
import LayersIcon from "@mui/icons-material/Layers";
import RefreshIcon from "@mui/icons-material/Refresh";
import SensorsIcon from "@mui/icons-material/Sensors";
import { styled } from "@mui/material/styles";
import type { CompositeAsset } from "../../../types/TimelineTypes";
import { useAsset } from "../../userAssets/api";
import { tickToMediaSeconds } from "../../renderer/utils/mediaTime";
import { createCompositeBaseClipFromAsset } from "../utils/createCompositeClip";
import { useCompositeLibraryStore } from "../useCompositeLibraryStore";
import {
  setCompositeForceLive,
  useCompositeBakeRuntimeStatus,
  useIsCompositeForceLive,
} from "../useCompositeRenderStatusStore";

interface CompositeCardProps {
  composite: CompositeAsset;
  isSelected: boolean;
  disableDrag?: boolean;
  onSelect: (event: MouseEvent<HTMLDivElement>) => void;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onPlaceOnTimeline: () => void;
}

const CardRoot = styled("div")({
  position: "relative",
  minHeight: 158,
  borderRadius: 10,
  overflow: "hidden",
  background:
    "linear-gradient(145deg, rgba(39, 28, 70, 0.92), rgba(16, 18, 27, 0.96))",
  border: "1px solid rgba(255, 255, 255, 0.1)",
  color: "#f8fafc",
  cursor: "grab",
  boxShadow: "0 10px 24px rgba(0, 0, 0, 0.24)",
  transition: "border-color 0.14s ease, transform 0.14s ease",
  "&:hover": {
    borderColor: "rgba(167, 139, 250, 0.72)",
    transform: "translateY(-1px)",
  },
});

const PreviewArea = styled("div")({
  height: 86,
  position: "relative",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background:
    "radial-gradient(circle at 20% 25%, rgba(167, 139, 250, 0.35), transparent 32%), linear-gradient(135deg, rgba(76, 29, 149, 0.38), rgba(15, 23, 42, 0.86))",
});

const ActionRail = styled("div")({
  position: "absolute",
  top: 6,
  right: 6,
  display: "flex",
  gap: 4,
  padding: 4,
  borderRadius: 999,
  backgroundColor: "rgba(0, 0, 0, 0.38)",
  backdropFilter: "blur(6px)",
});

function CompositeCardComponent({
  composite,
  isSelected,
  disableDrag = false,
  onSelect,
  onOpen,
  onRename,
  onDelete,
  onPlaceOnTimeline,
}: CompositeCardProps) {
  const bakedAsset = useAsset(composite.bake?.assetId ?? composite.bakedAssetId);
  const retryCompositeBake = useCompositeLibraryStore(
    (state) => state.retryCompositeBake,
  );
  const runtimeBake = useCompositeBakeRuntimeStatus(composite.id);
  const forceLive = useIsCompositeForceLive(composite.id);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `composite-asset-${composite.id}`,
    data: {
      type: "asset",
      clip: createCompositeBaseClipFromAsset(composite),
      compositeAsset: composite,
    },
    disabled: disableDrag,
  });

  const stopAction = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <CardRoot
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-testid="composite-card"
      data-composite-id={composite.id}
      data-selected={isSelected ? "true" : "false"}
      onClick={onSelect}
      style={{
        opacity: isDragging ? 0.55 : 1,
        outline: isSelected ? "2px solid #fff" : "2px solid transparent",
        outlineOffset: "-2px",
        cursor: disableDrag ? "default" : "grab",
      }}
    >
      <PreviewArea>
        {bakedAsset?.thumbnail || bakedAsset?.src ? (
          <img
            src={bakedAsset.thumbnail || bakedAsset.src}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              opacity: 0.78,
            }}
          />
        ) : (
          <LayersIcon sx={{ fontSize: 34, color: "#ddd6fe" }} />
        )}
        <ActionRail>
          <Tooltip title="Edit composite">
            <IconButton
              size="small"
              aria-label="Edit composite"
              onMouseDown={stopAction}
              onClick={(event) => {
                stopAction(event);
                onOpen();
              }}
              sx={{ color: "#fff" }}
            >
              <EditIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Place on timeline">
            <IconButton
              size="small"
              aria-label="Place composite on timeline"
              onMouseDown={stopAction}
              onClick={(event) => {
                stopAction(event);
                onPlaceOnTimeline();
              }}
              sx={{ color: "#fff" }}
            >
              <AddToTimelineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </ActionRail>
      </PreviewArea>
      <Box sx={{ p: 1.1, display: "flex", flexDirection: "column", gap: 0.6 }}>
        <Typography variant="subtitle2" noWrap title={composite.name}>
          {composite.name}
        </Typography>
        <Typography variant="caption" sx={{ color: "#c4b5fd" }}>
          {tickToMediaSeconds(composite.content.durationTicks).toFixed(2)}s
        </Typography>
        <Typography
          variant="caption"
          data-testid="composite-bake-status"
          sx={{ color: composite.bake?.status === "failed" ? "#fecaca" : "#aeb4bd" }}
          noWrap
          title={composite.bake?.error}
        >
          {runtimeBake?.status === "rendering"
            ? `Baking ${Math.round(runtimeBake.progress)}%`
            : runtimeBake?.status === "queued"
              ? "Bake queued"
              : composite.bake?.status === "failed"
                ? `Bake failed: ${composite.bake.error ?? "Retry available"}`
                : composite.bake?.status === "ready"
                  ? "Bake ready"
                  : "Live only"}
        </Typography>
        <Box sx={{ display: "flex", gap: 0.5, justifyContent: "flex-end" }}>
          {composite.bake?.status === "failed" ? (
            <Tooltip title="Retry background bake">
              <IconButton
                size="small"
                aria-label="Retry background bake"
                onMouseDown={stopAction}
                onClick={(event) => {
                  stopAction(event);
                  void retryCompositeBake(composite.id);
                }}
                sx={{ color: "#fecaca" }}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
          <Tooltip title={forceLive ? "Use automatic source policy" : "Force live rendering"}>
            <IconButton
              size="small"
              aria-label={forceLive ? "Use automatic source policy" : "Force live rendering"}
              aria-pressed={forceLive}
              onMouseDown={stopAction}
              onClick={(event) => {
                stopAction(event);
                setCompositeForceLive(composite.id, !forceLive);
              }}
              sx={{ color: forceLive ? "#86efac" : "#cbd5e1" }}
            >
              <SensorsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Rename">
            <IconButton
              size="small"
              aria-label="Rename composite"
              onMouseDown={stopAction}
              onClick={(event) => {
                stopAction(event);
                onRename();
              }}
              sx={{ color: "#cbd5e1" }}
            >
              <DriveFileRenameOutlineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete">
            <IconButton
              size="small"
              aria-label="Delete composite"
              onMouseDown={stopAction}
              onClick={(event) => {
                stopAction(event);
                onDelete();
              }}
              sx={{ color: "#fecaca" }}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
    </CardRoot>
  );
}

export const CompositeCard = memo(CompositeCardComponent);
