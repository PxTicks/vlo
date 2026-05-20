import React from "react";
import { Box, Typography, IconButton } from "@mui/material";
import { styled } from "@mui/material/styles";
import { useDroppable, useDndContext, useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import CloseIcon from "@mui/icons-material/Close";
import type { Asset, AssetType } from "../../../types/Asset";
import { assetMatchesType } from "../../../shared/utils/assetTypeDetection";
import type { AssetDropSlotProps } from "./assetDropSlotTypes";
import {
  getExternalFileDragHighlight,
  getFirstAcceptedFile,
  hasDraggedFiles,
} from "./assetDropSlotUtils";

const SLOT_SIZE = 80;

const SlotContainer = styled(Box)({
  display: "inline-flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 4,
});

const SlotBox = styled(Box, {
  shouldForwardProp: (prop) =>
    prop !== "filled" && prop !== "highlight",
})<{
  filled?: boolean;
  highlight?: "compatible" | "incompatible" | "external" | null;
}>(
  ({ filled, highlight }) => ({
    width: SLOT_SIZE,
    height: SLOT_SIZE,
    borderRadius: 6,
    backgroundColor: "#1a1a1a",
    border:
      highlight === "compatible"
        ? "2px solid #90caf9"
        : highlight === "incompatible"
          ? "2px solid #f44336"
          : highlight === "external"
            ? "2px dashed #b0bec5"
          : filled
            ? "1px solid #444"
            : "1px dashed #555",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    overflow: "hidden",
    transition: "border-color 0.15s",
  }),
);

const ClearButton = styled(IconButton)({
  position: "absolute",
  top: 2,
  right: 2,
  padding: 2,
  backgroundColor: "rgba(0, 0, 0, 0.6)",
  color: "#fff",
  opacity: 0,
  transition: "opacity 0.15s",
  "&:hover": {
    backgroundColor: "rgba(200, 0, 0, 0.8)",
  },
});

function formatAcceptLabel(accept: AssetType[]): string {
  return accept.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" / ");
}

function AssetDropSlotComponent({
  id,
  accept,
  value,
  onClear,
  onDrop,
  onExternalDrop,
  onSelect,
  label,
  reorderData,
  onReorderDrop,
}: AssetDropSlotProps) {
  const filled = value != null;
  const isReorderable = filled && reorderData != null;
  const [externalHighlight, setExternalHighlight] = React.useState<
    "compatible" | "incompatible" | "external" | null
  >(null);
  const externalDragDepthRef = React.useRef(0);

  const { setNodeRef: setDroppableNodeRef, isOver } = useDroppable({
    id: `asset-slot-${id}`,
    data: { type: "asset-slot", accept, onDrop, onReorderDrop },
  });
  const {
    listeners,
    setNodeRef: setDraggableNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: `asset-slot-item-${id}`,
    data: reorderData ?? undefined,
    disabled: !isReorderable,
  });
  const setNodeRef = React.useCallback(
    (node: HTMLElement | null) => {
      setDroppableNodeRef(node);
      setDraggableNodeRef(node);
    },
    [setDraggableNodeRef, setDroppableNodeRef],
  );

  // Determine highlight state when dragging over
  const { active } = useDndContext();
  let highlight: "compatible" | "incompatible" | "external" | null = null;
  if (isOver && active?.data.current?.type === "asset") {
    const draggedAsset = active.data.current.asset as Asset | undefined;
    highlight =
      draggedAsset && accept.some((acceptedType) => assetMatchesType(draggedAsset, acceptedType))
        ? "compatible"
        : "incompatible";
  }
  if (
    isOver &&
    active?.data.current?.type === "media-input" &&
    typeof onReorderDrop === "function" &&
    active.data.current.inputId !== id
  ) {
    highlight = "compatible";
  }
  if (externalHighlight) {
    highlight = externalHighlight;
  }

  const thumbnail = value?.thumbnail ?? null;

  return (
    <SlotContainer
      sx={{
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.65 : 1,
        zIndex: isDragging ? 1 : "auto",
      }}
    >
      {label && (
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", fontSize: "0.65rem" }}
        >
          {label}
        </Typography>
      )}
      <SlotBox
        ref={setNodeRef}
        filled={filled}
        highlight={highlight}
        data-drop-slot-id={id}
        {...(isReorderable ? listeners : {})}
        sx={{
          "&:hover .drop-slot-clear": {
            opacity: 1,
          },
          cursor: isReorderable
            ? isDragging
              ? "grabbing"
              : "grab"
            : onSelect
              ? "pointer"
              : "default",
        }}
        role={onSelect ? "button" : undefined}
        tabIndex={onSelect ? 0 : -1}
        onClick={onSelect}
        onDragEnter={(event) => {
          if (!onExternalDrop || !hasDraggedFiles(event.dataTransfer)) {
            return;
          }

          event.preventDefault();
          externalDragDepthRef.current += 1;
          setExternalHighlight(
            getExternalFileDragHighlight(event.dataTransfer, accept),
          );
        }}
        onDragOver={(event) => {
          if (!onExternalDrop || !hasDraggedFiles(event.dataTransfer)) {
            return;
          }

          event.preventDefault();
          const nextHighlight = getExternalFileDragHighlight(
            event.dataTransfer,
            accept,
          );
          event.dataTransfer.dropEffect =
            nextHighlight === "incompatible" ? "none" : "copy";
          setExternalHighlight(nextHighlight);
        }}
        onDragLeave={(event) => {
          if (!onExternalDrop || !hasDraggedFiles(event.dataTransfer)) {
            return;
          }

          event.preventDefault();
          externalDragDepthRef.current = Math.max(
            0,
            externalDragDepthRef.current - 1,
          );
          if (externalDragDepthRef.current === 0) {
            setExternalHighlight(null);
          }
        }}
        onDrop={(event) => {
          if (!onExternalDrop || !hasDraggedFiles(event.dataTransfer)) {
            return;
          }

          event.preventDefault();
          externalDragDepthRef.current = 0;
          setExternalHighlight(null);
          const acceptedFile = getFirstAcceptedFile(
            Array.from(event.dataTransfer.files),
            accept,
          );
          if (!acceptedFile) {
            return;
          }
          void onExternalDrop(acceptedFile);
        }}
        onKeyDown={(event) => {
          if (!onSelect) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
      >
        {filled ? (
          <>
            {value!.type === "audio" ? (
              <MusicNoteIcon sx={{ fontSize: 32, color: "#888" }} />
            ) : thumbnail ? (
              <img
                src={thumbnail}
                alt={value!.name}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            ) : (
              <Typography
                variant="caption"
                sx={{ color: "#555", fontSize: "0.6rem" }}
              >
                No Preview
              </Typography>
            )}
            {onClear && (
              <ClearButton
                className="drop-slot-clear"
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  onClear();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <CloseIcon sx={{ fontSize: 12 }} />
              </ClearButton>
            )}
          </>
        ) : (
          <Box
            sx={{
              textAlign: "center",
              px: 0.5,
              userSelect: "none",
              lineHeight: 1.15,
            }}
          >
            <Typography variant="caption" sx={{ color: "#555", fontSize: "0.6rem" }}>
              {formatAcceptLabel(accept)}
            </Typography>
            {onSelect && (
              <Typography
                variant="caption"
                sx={{ color: "#777", fontSize: "0.55rem", display: "block" }}
              >
                Drop or click
              </Typography>
            )}
          </Box>
        )}
      </SlotBox>
      {filled && (
        <Typography
          variant="caption"
          noWrap
          sx={{
            color: "text.secondary",
            fontSize: "0.6rem",
            maxWidth: SLOT_SIZE,
          }}
          title={value!.name}
        >
          {value!.name}
        </Typography>
      )}
    </SlotContainer>
  );
}

export const AssetDropSlot = React.memo(AssetDropSlotComponent);
