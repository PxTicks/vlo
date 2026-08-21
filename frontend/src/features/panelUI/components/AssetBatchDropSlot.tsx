import React from "react";
import { Box, Typography, IconButton, CircularProgress, Tooltip } from "@mui/material";
import { styled } from "@mui/material/styles";
import { useDroppable, useDndContext, useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import CloseIcon from "@mui/icons-material/Close";
import EditIcon from "@mui/icons-material/Edit";
import AddIcon from "@mui/icons-material/Add";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import type { Asset, AssetType } from "../../../types/Asset";
import { assetMatchesType } from "../../../shared/utils/assetTypeDetection";
import type {
  AssetBatchDropSlotProps,
  AssetBatchSlotItem,
  AssetBatchSlotOption,
} from "./assetBatchDropSlotTypes";
import type { AssetDropSlotReorderData } from "./assetDropSlotTypes";
import {
  getExternalFileDragHighlight,
  getFirstAcceptedFile,
  hasDraggedFiles,
} from "./assetDropSlotUtils";

const TILE_SIZE = 64;

type DragHighlight = "compatible" | "incompatible" | "external" | null;

/**
 * The batch reads as one slot: a single border wraps every position, and the
 * tiles inside flow to the panel's width instead of being laid out on a fixed
 * grid, so the same strip fits a narrow sidebar and a wide docked tab.
 */
const StripContainer = styled(Box)({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  gap: 6,
  width: "100%",
  boxSizing: "border-box",
  padding: 6,
  borderRadius: 6,
  backgroundColor: "#141416",
  border: "1px solid #3a3a3a",
});

const Tile = styled(Box, {
  shouldForwardProp: (prop) => prop !== "filled" && prop !== "highlight",
})<{ filled?: boolean; highlight?: DragHighlight }>(({ filled, highlight }) => ({
  width: TILE_SIZE,
  height: TILE_SIZE,
  flex: "0 0 auto",
  borderRadius: 4,
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
}));

const CornerButton = styled(IconButton)({
  position: "absolute",
  padding: 1,
  backgroundColor: "rgba(0, 0, 0, 0.6)",
  color: "#fff",
  opacity: 0,
  transition: "opacity 0.15s",
});

const ClearButton = styled(CornerButton)({
  top: 1,
  right: 1,
  "&:hover": { backgroundColor: "rgba(200, 0, 0, 0.8)" },
});

const EditButton = styled(CornerButton)({
  top: 1,
  left: 1,
  "&:hover": { backgroundColor: "rgba(33, 150, 243, 0.85)" },
});

const OrdinalBadge = styled(Typography)({
  position: "absolute",
  bottom: 1,
  left: 2,
  paddingInline: 3,
  borderRadius: 3,
  backgroundColor: "rgba(0, 0, 0, 0.65)",
  color: "#ddd",
  fontSize: "0.55rem",
  lineHeight: 1.4,
  pointerEvents: "none",
});

/**
 * Per-item options stay visible rather than hover-revealed: an item's audio
 * state is part of what the batch will deliver, so it has to be readable
 * without hunting tile by tile.
 */
const OptionButton = styled(IconButton, {
  shouldForwardProp: (prop) => prop !== "active",
})<{ active?: boolean }>(({ active }) => ({
  position: "absolute",
  bottom: 1,
  right: 1,
  padding: 1,
  backgroundColor: active ? "rgba(33, 150, 243, 0.85)" : "rgba(0, 0, 0, 0.65)",
  color: active ? "#fff" : "#999",
  "&:hover": {
    backgroundColor: active ? "rgba(33, 150, 243, 1)" : "rgba(0, 0, 0, 0.85)",
  },
}));

function optionIcon(option: AssetBatchSlotOption) {
  const sx = { fontSize: 11 } as const;
  return option.active ? <VolumeUpIcon sx={sx} /> : <VolumeOffIcon sx={sx} />;
}

function resolveAssetHighlight(
  asset: Asset | undefined,
  accept: AssetType[],
  acceptAsset: ((asset: Asset) => boolean) | undefined,
): DragHighlight {
  if (!asset) return "incompatible";
  return accept.some((acceptedType) => assetMatchesType(asset, acceptedType)) ||
    acceptAsset?.(asset) === true
    ? "compatible"
    : "incompatible";
}

interface BatchTileProps {
  /** Position in delivery order; the add tile sits at `items.length`. */
  index: number;
  /** `null` renders the trailing add tile. */
  item: AssetBatchSlotItem | null;
  label: string;
  accept: AssetType[];
  acceptAsset?: (asset: Asset) => boolean;
  acceptExternal: AssetType[];
  onDrop?: (index: number, asset: Asset) => void;
  onExternalDrop?: (index: number, file: File) => void | Promise<void>;
  onSelect?: (index: number) => void;
  onClear?: (slotId: string) => void;
  onEdit?: (slotId: string) => void;
  onReorder?: (slotId: string, toIndex: number) => void;
  onToggleOption?: (
    slotId: string,
    optionId: string,
    nextActive: boolean,
  ) => void;
  /**
   * Identifies the position in the DOM and to dnd-kit. Filled positions use
   * their slot id; the trailing add tile uses the strip's own id.
   */
  slotKey: string;
}

function BatchTile({
  index,
  item,
  label,
  accept,
  acceptAsset,
  acceptExternal,
  onDrop,
  onExternalDrop,
  onSelect,
  onClear,
  onEdit,
  onReorder,
  onToggleOption,
  slotKey,
}: BatchTileProps) {
  const [externalHighlight, setExternalHighlight] =
    React.useState<DragHighlight>(null);
  const externalDragDepthRef = React.useRef(0);

  const handleAssetDrop = React.useCallback(
    (asset: Asset) => onDrop?.(index, asset),
    [index, onDrop],
  );
  const handleReorderDrop = React.useCallback(
    (data: AssetDropSlotReorderData) => onReorder?.(data.inputId, index),
    [index, onReorder],
  );

  const { setNodeRef: setDroppableNodeRef, isOver } = useDroppable({
    id: `asset-slot-${slotKey}`,
    data: {
      type: "asset-slot",
      accept,
      acceptAsset,
      onDrop: onDrop ? handleAssetDrop : undefined,
      onReorderDrop: onReorder ? handleReorderDrop : undefined,
    },
  });
  const {
    listeners,
    setNodeRef: setDraggableNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: `asset-batch-item-${slotKey}`,
    data: item
      ? ({ type: "media-input", inputId: item.slotId } satisfies AssetDropSlotReorderData)
      : undefined,
    disabled: !item || !onReorder,
  });
  const setNodeRef = React.useCallback(
    (node: HTMLElement | null) => {
      setDroppableNodeRef(node);
      setDraggableNodeRef(node);
    },
    [setDraggableNodeRef, setDroppableNodeRef],
  );

  const { active } = useDndContext();
  let highlight: DragHighlight = null;
  if (isOver && active?.data.current?.type === "asset") {
    highlight = resolveAssetHighlight(
      active.data.current.asset as Asset | undefined,
      accept,
      acceptAsset,
    );
  }
  if (
    isOver &&
    active?.data.current?.type === "media-input" &&
    onReorder &&
    active.data.current.inputId !== item?.slotId
  ) {
    highlight = "compatible";
  }
  if (externalHighlight) {
    highlight = externalHighlight;
  }

  const status = item?.value.status ?? null;
  const thumbnail = item?.value.thumbnail ?? null;
  const isReorderable = item != null && onReorder != null;
  const title = item
    ? (item.value.statusMessage ?? `${label} — ${item.value.name}`)
    : label;

  return (
    <Tile
      ref={setNodeRef}
      filled={item != null}
      highlight={highlight}
      data-drop-slot-id={slotKey}
      title={title}
      {...(isReorderable ? listeners : {})}
      sx={{
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.65 : 1,
        zIndex: isDragging ? 1 : "auto",
        "&:hover .batch-slot-clear": { opacity: 1 },
        "&:hover .batch-slot-edit": { opacity: 1 },
        cursor: isReorderable
          ? isDragging
            ? "grabbing"
            : "grab"
          : onSelect
            ? "pointer"
            : "default",
      }}
      role={onSelect ? "button" : undefined}
      aria-label={item ? title : `${label} (add)`}
      tabIndex={onSelect ? 0 : -1}
      onClick={onSelect ? () => onSelect(index) : undefined}
      onKeyDown={(event: React.KeyboardEvent) => {
        if (!onSelect) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(index);
        }
      }}
      onDragEnter={(event: React.DragEvent) => {
        if (!onExternalDrop || !hasDraggedFiles(event.dataTransfer)) return;
        event.preventDefault();
        externalDragDepthRef.current += 1;
        setExternalHighlight(
          getExternalFileDragHighlight(event.dataTransfer, acceptExternal),
        );
      }}
      onDragOver={(event: React.DragEvent) => {
        if (!onExternalDrop || !hasDraggedFiles(event.dataTransfer)) return;
        event.preventDefault();
        // Stop the strip's own handler from claiming a drop the tile owns.
        event.stopPropagation();
        const nextHighlight = getExternalFileDragHighlight(
          event.dataTransfer,
          acceptExternal,
        );
        event.dataTransfer.dropEffect =
          nextHighlight === "incompatible" ? "none" : "copy";
        setExternalHighlight(nextHighlight);
      }}
      onDragLeave={(event: React.DragEvent) => {
        if (!onExternalDrop || !hasDraggedFiles(event.dataTransfer)) return;
        event.preventDefault();
        externalDragDepthRef.current = Math.max(
          0,
          externalDragDepthRef.current - 1,
        );
        if (externalDragDepthRef.current === 0) {
          setExternalHighlight(null);
        }
      }}
      onDrop={(event: React.DragEvent) => {
        if (!onExternalDrop || !hasDraggedFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        externalDragDepthRef.current = 0;
        setExternalHighlight(null);
        const acceptedFile = getFirstAcceptedFile(
          Array.from(event.dataTransfer.files),
          acceptExternal,
        );
        if (!acceptedFile) return;
        void onExternalDrop(index, acceptedFile);
      }}
    >
      {item ? (
        <>
          {status === "preparing" ? (
            <CircularProgress size={20} sx={{ color: "#90caf9" }} />
          ) : status === "error" ? (
            <ErrorOutlineIcon sx={{ fontSize: 26, color: "#f44336" }} />
          ) : item.value.type === "audio" ? (
            <MusicNoteIcon sx={{ fontSize: 26, color: "#888" }} />
          ) : thumbnail ? (
            <img
              src={thumbnail}
              alt={item.value.name}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <Typography variant="caption" sx={{ color: "#555", fontSize: "0.55rem" }}>
              No Preview
            </Typography>
          )}
          <OrdinalBadge variant="caption">{index + 1}</OrdinalBadge>
          {item.editable && onEdit && (
            <EditButton
              className="batch-slot-edit"
              size="small"
              aria-label={`Edit ${label}`}
              onClick={(event) => {
                event.stopPropagation();
                onEdit(item.slotId);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <EditIcon sx={{ fontSize: 11 }} />
            </EditButton>
          )}
          {onClear && (
            <ClearButton
              className="batch-slot-clear"
              size="small"
              aria-label={`Remove ${label}`}
              onClick={(event) => {
                event.stopPropagation();
                onClear(item.slotId);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <CloseIcon sx={{ fontSize: 11 }} />
            </ClearButton>
          )}
          {onToggleOption &&
            item.options?.map((option) => (
              <Tooltip
                key={option.id}
                title={
                  (option.active ? option.activeLabel : option.label) ??
                  option.label
                }
              >
                <OptionButton
                  size="small"
                  active={option.active}
                  aria-label={option.label}
                  aria-pressed={option.active}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleOption(item.slotId, option.id, !option.active);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  {optionIcon(option)}
                </OptionButton>
              </Tooltip>
            ))}
        </>
      ) : (
        <AddIcon sx={{ fontSize: 22, color: "#666" }} />
      )}
    </Tile>
  );
}

function formatAcceptLabel(accept: AssetType[]): string {
  return accept.map((type) => type.charAt(0).toUpperCase() + type.slice(1)).join(" / ");
}

function AssetBatchDropSlotComponent({
  id,
  accept,
  acceptAsset,
  acceptExternal,
  items,
  max,
  itemLabel,
  onDrop,
  onExternalDrop,
  onSelect,
  onClear,
  onEdit,
  onReorder,
  onToggleOption,
}: AssetBatchDropSlotProps) {
  const externalAccept = acceptExternal ?? accept;
  const capacity = Math.max(1, Math.floor(max));
  const visibleItems = items.slice(0, capacity);
  const hasAddTile = visibleItems.length < capacity;
  const resolveLabel = React.useCallback(
    (index: number) =>
      itemLabel?.(index) ?? `${formatAcceptLabel(accept)} ${index + 1}`,
    [accept, itemLabel],
  );

  // Items report their own failures through the tile, but a strip can hold
  // several; surface the first one as text so a failed item is not just a red
  // border the user has to hover to understand.
  const failedItem = visibleItems.find(
    (item) => item.value.status === "error",
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
      <StripContainer
        data-batch-slot-id={id}
        onDragOver={(event: React.DragEvent) => {
          // Only fires for the gaps between tiles: a tile that can take the
          // drop stops the event before it reaches here.
          if (!onExternalDrop || !hasAddTile) return;
          if (!hasDraggedFiles(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect =
            getExternalFileDragHighlight(event.dataTransfer, externalAccept) ===
            "incompatible"
              ? "none"
              : "copy";
        }}
        onDrop={(event: React.DragEvent) => {
          if (!onExternalDrop || !hasAddTile) return;
          if (!hasDraggedFiles(event.dataTransfer)) return;
          event.preventDefault();
          const acceptedFile = getFirstAcceptedFile(
            Array.from(event.dataTransfer.files),
            externalAccept,
          );
          if (!acceptedFile) return;
          void onExternalDrop(visibleItems.length, acceptedFile);
        }}
      >
        {visibleItems.map((item, index) => (
          <BatchTile
            key={item.slotId}
            index={index}
            item={item}
            label={resolveLabel(index)}
            accept={accept}
            acceptAsset={acceptAsset}
            acceptExternal={externalAccept}
            slotKey={item.slotId}
            onDrop={onDrop}
            onExternalDrop={onExternalDrop}
            onSelect={onSelect}
            onClear={onClear}
            onEdit={onEdit}
            onReorder={onReorder}
            onToggleOption={onToggleOption}
          />
        ))}
        {hasAddTile && (
          <BatchTile
            key="add"
            index={visibleItems.length}
            item={null}
            label={resolveLabel(visibleItems.length)}
            accept={accept}
            acceptAsset={acceptAsset}
            acceptExternal={externalAccept}
            slotKey={`${id}-add`}
            onDrop={onDrop}
            onExternalDrop={onExternalDrop}
            onSelect={onSelect}
            onReorder={onReorder}
          />
        )}
      </StripContainer>
      <Typography
        variant="caption"
        sx={{ color: "text.secondary", fontSize: "0.6rem" }}
      >
        {visibleItems.length === 0
          ? `Drop or click to add ${formatAcceptLabel(accept).toLowerCase()} references`
          : `${visibleItems.length}/${capacity} · drag to reorder`}
      </Typography>
      {failedItem && (
        <Typography
          variant="caption"
          sx={{ color: "error.main", fontSize: "0.6rem" }}
        >
          {failedItem.value.statusMessage ??
            `${failedItem.value.name} could not be prepared`}
        </Typography>
      )}
    </Box>
  );
}

export const AssetBatchDropSlot = React.memo(AssetBatchDropSlotComponent);
