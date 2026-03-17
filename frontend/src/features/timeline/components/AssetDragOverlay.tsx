import React from "react";
import { DragOverlay, useDndContext } from "@dnd-kit/core";
import { useShallow } from "zustand/react/shallow";
import { Box } from "@mui/material";
import { TimelineClipItem } from "./TimelineClip";
import { useInteractionStore } from "../hooks/useInteractionStore";
import { snapToCursorOffset } from "../hooks/dnd/dragGeometry";
import { useTimelineViewStore } from "../hooks/useTimelineViewStore";
import type { Asset } from "../../../types/Asset";

export const AssetDragOverlay = React.memo(() => {
  const { activeClip, operation, isOverTimeline } = useInteractionStore(
    useShallow((state) => ({
      activeClip: state.activeClip,
      operation: state.operation,
      isOverTimeline: state.isOverTimeline,
    })),
  );

  const { active } = useDndContext();
  const zoomScale = useTimelineViewStore((state) => state.zoomScale);

  // Show only if we are moving a new Asset (implied by clip type 'asset' conceptually,
  // but practically it is a BaseClip without trackId in the interaction store context from useAssetDrag)
  if (operation !== "move" || !activeClip) return null;

  // STRICT CHECK: Is this a TimelineClip or a BaseClip (New Asset)?
  // TimelineClips have 'trackId'. New Assets do not (yet).
  const isTimelineClip = "trackId" in activeClip;

  if (isTimelineClip) return null;

  // Retrieve the full Asset object from the drag payload
  const asset = active?.data.current?.asset as Asset | undefined;

  // CASE 1: NOT OVER TIMELINE -> SHOW THUMBNAIL (Standard Cursor Follow)
  if (!isOverTimeline && asset) {
    return (
      <DragOverlay dropAnimation={null}>
        <Box
          sx={{
            width: 180, // Approximate card width
            height: 100,
            bgcolor: "#252525",
            borderRadius: 1,
            overflow: "hidden",
            boxShadow: 3,
            position: "relative",
            opacity: 0.9,
            border: "1px solid #555",
          }}
        >
          {asset.thumbnail || asset.type === "image" ? (
            <img
              src={asset.thumbnail || asset.src}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <Box
              sx={{
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#888",
              }}
            >
              {asset.name}
            </Box>
          )}
        </Box>
      </DragOverlay>
    );
  }

  // CASE 2: OVER TIMELINE -> SHOW CLIP PREVIEW (Snapped Offset)
  return (
    <DragOverlay
      dropAnimation={null}
      modifiers={[snapToCursorOffset]}
      style={{ "--timeline-zoom": zoomScale } as React.CSSProperties}
    >
      <TimelineClipItem clip={activeClip} isOverlay />
    </DragOverlay>
  );
});
