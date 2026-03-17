import React from "react";
import { Box, Typography, IconButton } from "@mui/material";
import { styled } from "@mui/material/styles";
import { useDroppable, useDndContext } from "@dnd-kit/core";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import CloseIcon from "@mui/icons-material/Close";
import type { Asset, AssetType } from "../../../types/Asset";

export interface AssetDropSlotValue {
  type: AssetType;
  name: string;
  thumbnail?: string;
}

export interface AssetDropSlotProps {
  /** Unique identifier for this slot */
  id: string;
  /** Which asset types this slot accepts */
  accept: AssetType[];
  /** Currently assigned asset */
  value?: AssetDropSlotValue | null;
  /** Callback to clear the assigned asset */
  onClear?: () => void;
  /** Called when a compatible asset is dropped on this slot */
  onDrop?: (asset: Asset) => void;
  /** Called when the slot is clicked to select from timeline */
  onSelect?: () => void;
  /** Label shown above the slot */
  label?: string;
}

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
})<{ filled?: boolean; highlight?: "compatible" | "incompatible" | null }>(
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
  onSelect,
  label,
}: AssetDropSlotProps) {
  const filled = value != null;

  const { setNodeRef, isOver } = useDroppable({
    id: `asset-slot-${id}`,
    data: { type: "asset-slot", accept, onDrop },
  });

  // Determine highlight state when dragging over
  const { active } = useDndContext();
  let highlight: "compatible" | "incompatible" | null = null;
  if (isOver && active?.data.current?.type === "asset") {
    const draggedType = (active.data.current.asset as Asset | undefined)?.type;
    highlight =
      draggedType && accept.includes(draggedType)
        ? "compatible"
        : "incompatible";
  }

  const thumbnail = value?.thumbnail ?? null;

  return (
    <SlotContainer>
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
        sx={{
          "&:hover .drop-slot-clear": {
            opacity: 1,
          },
          cursor: onSelect ? "pointer" : "default",
        }}
        role={onSelect ? "button" : undefined}
        tabIndex={onSelect ? 0 : -1}
        onClick={onSelect}
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
