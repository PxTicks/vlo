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
  /** Called when a compatible external file is dropped on this slot */
  onExternalDrop?: (file: File) => void | Promise<void>;
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

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".bmp",
  ".gif",
]);
const AUDIO_EXTENSIONS = new Set([
  ".wav",
  ".mp3",
  ".ogg",
  ".flac",
  ".m4a",
  ".aac",
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".mkv"]);

function fileExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : "";
}

function getFileAssetType(file: File): AssetType | null {
  const extension = fileExtension(file.name);
  if (file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (file.type.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }
  if (file.type.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  return null;
}

function getItemAssetType(
  item: Pick<DataTransferItem, "kind" | "type">,
): AssetType | null {
  if (item.kind !== "file") return null;
  if (item.type.startsWith("image/")) return "image";
  if (item.type.startsWith("audio/")) return "audio";
  if (item.type.startsWith("video/")) return "video";
  return null;
}

function hasDraggedFiles(dataTransfer: Pick<DataTransfer, "types"> | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types).includes("Files");
}

export function getExternalFileDragHighlight(
  dataTransfer: Pick<DataTransfer, "types" | "items" | "files"> | null,
  accept: readonly AssetType[],
): "compatible" | "incompatible" | "external" | null {
  if (!hasDraggedFiles(dataTransfer)) {
    return null;
  }

  const items = Array.from(dataTransfer.items ?? []);
  let sawTypedFile = false;
  for (const item of items) {
    const itemType = getItemAssetType(item);
    if (!itemType) continue;
    sawTypedFile = true;
    if (accept.includes(itemType)) {
      return "compatible";
    }
  }
  if (sawTypedFile) {
    return "incompatible";
  }

  const files = Array.from(dataTransfer.files ?? []);
  if (files.length > 0) {
    return getFirstAcceptedFile(files, accept) ? "compatible" : "incompatible";
  }

  return "external";
}

function getFirstAcceptedFile(
  files: readonly File[],
  accept: readonly AssetType[],
): File | null {
  for (const file of files) {
    const fileType = getFileAssetType(file);
    if (fileType && accept.includes(fileType)) {
      return file;
    }
  }

  return null;
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
}: AssetDropSlotProps) {
  const filled = value != null;
  const [externalHighlight, setExternalHighlight] = React.useState<
    "compatible" | "incompatible" | "external" | null
  >(null);
  const externalDragDepthRef = React.useRef(0);

  const { setNodeRef, isOver } = useDroppable({
    id: `asset-slot-${id}`,
    data: { type: "asset-slot", accept, onDrop },
  });

  // Determine highlight state when dragging over
  const { active } = useDndContext();
  let highlight: "compatible" | "incompatible" | "external" | null = null;
  if (isOver && active?.data.current?.type === "asset") {
    const draggedType = (active.data.current.asset as Asset | undefined)?.type;
    highlight =
      draggedType && accept.includes(draggedType)
        ? "compatible"
        : "incompatible";
  }
  if (externalHighlight) {
    highlight = externalHighlight;
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
