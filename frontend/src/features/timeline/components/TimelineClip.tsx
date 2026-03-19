import { memo, useEffect, useRef } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Box, Typography, Paper } from "@mui/material";

import { styled } from "@mui/material/styles";
import {
  CLIP_HEIGHT,
  TICKS_PER_SECOND,
  PIXELS_PER_SECOND,
  TRACK_HEIGHT,
  TRACK_HEADER_WIDTH,
  RULER_HEIGHT,
} from "../constants";
import type {
  BaseClip,
  TimelineClip as TimelineClipType,
} from "../../../types/TimelineTypes";
import { useTimelineStore } from "../useTimelineStore";
import { useInteractionStore } from "../hooks/useInteractionStore";
import { ThumbnailCanvas } from "./ThumbnailCanvas";
import { SplineOverlay } from "./SplineOverlay";

// --- Sub-component for Handles ---
interface HandleProps {
  id: string;
  clip: TimelineClipType;
  side: "left" | "right";
}

const ResizeHandle = ({ id, clip, side }: HandleProps) => {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id,
    data: { clip, type: "resize", side },
  });

  return (
    <Box
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-testid={`timeline-clip-resize-handle-${side}`}
      sx={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [side]: 0,
        width: "12px",
        cursor: "ew-resize",
        zIndex: 20,
        "&::after": {
          content: '""',
          position: "absolute",
          top: 0,
          bottom: 0,
          left: side === "right" ? "6px" : undefined,
          right: side === "left" ? "6px" : undefined,
          width: "6px",
          bgcolor: "rgba(255,255,255,0.5)",
        },
        "&:hover::after": { bgcolor: "white" },
      }}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
};

// --- Styled Components ---

const ClipRoot = styled(Paper)(({ theme }) => ({
  position: "absolute",
  height: CLIP_HEIGHT,
  color: "#fff",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "center",
  overflow: "hidden",
  userSelect: "none",
  paddingLeft: theme.spacing(1),
  borderRadius: "4px",
  pointerEvents: "auto",
}));

// --- Main Component ---
interface TimelineClipProps {
  clip: BaseClip | TimelineClipType;
  isOverlay?: boolean;
}

function TimelineClipComponent({ clip, isOverlay = false }: TimelineClipProps) {
  const domRef = useRef<HTMLElement | null>(null);

  const startTime = "start" in clip ? (clip as TimelineClipType).start : 0;

  // --- SELECTORS ---
  const isSelected = useTimelineStore((state) =>
    state.selectedClipIds.includes(clip.id),
  );

  const isActive = useInteractionStore(
    (state) => state.activeId !== null && state.activeId.includes(clip.id),
  );

  const operation = useInteractionStore((state) => state.operation);

  // 1. Get Track Index
  const trackId = "trackId" in clip ? (clip as TimelineClipType).trackId : "";
  const tracks = useTimelineStore((state) => state.tracks);
  const trackIndex = tracks.findIndex((t) => t.id === trackId);
  const track = tracks[trackIndex];
  const isTrackVisible = track?.isVisible ?? true;

  // 2. Vertical Position
  const topPos = isOverlay ? 0 : trackIndex * TRACK_HEIGHT + RULER_HEIGHT + 5;

  // 3. Base Geometry Calculations
  const baseWidth =
    (clip.timelineDuration / TICKS_PER_SECOND) * PIXELS_PER_SECOND;
  const baseLeft = (startTime / TICKS_PER_SECOND) * PIXELS_PER_SECOND;

  const { attributes, listeners, setNodeRef, isDragging, transform } =
    useDraggable({
      id: clip.id,
      data: { clip, type: "clip" },
      disabled: isOverlay,
    });

  // 4. Transient Updates (Resizing & Moving)
  useEffect(() => {
    // We need to listen if:
    // 1. We are the Active Item (Leader or Resizing)
    // 2. OR We are Selected and the operation is "move" (Follower)
    const shouldSubscribe = isActive || (isSelected && operation === "move");

    if (isOverlay || !shouldSubscribe) return;

    // Define the update logic as a reusable function
    const updateStyle = (
      state: ReturnType<typeof useInteractionStore.getState>,
    ) => {
      const element = domRef.current;
      if (!element) return;

      const { currentDeltaX, currentDeltaY, constraints } = state;

      // A. RESIZE
      if (
        state.activeId === `resize_left_${clip.id}` ||
        state.activeId === `resize_right_${clip.id}`
      ) {
        const activeDeltaX = currentDeltaX;

        const getClampedDelta = (d: number) => {
          if (!constraints) return d;
          return Math.max(constraints.minPx, Math.min(d, constraints.maxPx));
        };
        const clampedDelta = getClampedDelta(activeDeltaX);

        if (state.activeId === `resize_right_${clip.id}`) {
          element.style.setProperty("--drag-delta-w", `${clampedDelta}px`);
          element.style.setProperty("--drag-delta-x", "0px");
        } else if (state.activeId === `resize_left_${clip.id}`) {
          element.style.setProperty("--drag-delta-x", `${clampedDelta}px`);
          element.style.setProperty("--drag-delta-w", `${-clampedDelta}px`);
        }
      }

      // B. MOVE (Follower Logic)
      // If we are part of the selection but NOT the leader (no transform from dnd-kit),
      // we must manually mirror the drag deltas.
      else if (state.operation === "move" && isSelected && !transform) {
        element.style.transform = `translate3d(${currentDeltaX}px, ${currentDeltaY}px, 0)`;
      }
    };

    // 1. Initial Sync
    updateStyle(useInteractionStore.getState());

    // 2. Subscribe
    const unsubscribe = useInteractionStore.subscribe(updateStyle);

    return () => {
      unsubscribe();
      if (domRef.current) {
        const element = domRef.current;
        const op = useInteractionStore.getState().operation;

        if (!op) {
          // Only delay on drag complete to prevent drop flicker
          requestAnimationFrame(() => {
            element.style.removeProperty("--drag-delta-x");
            element.style.removeProperty("--drag-delta-w");
          });
        } else {
          // Synchronous clear during drag to prevent RAF buildup lag
          element.style.removeProperty("--drag-delta-x");
          element.style.removeProperty("--drag-delta-w");
        }

        // Clean up manual transform if we applied it
        if (!transform) element.style.transform = "";
      }
    };
  }, [isActive, operation, clip.id, isOverlay, isSelected, transform]);

  const getBackgroundColor = () => {
    switch (clip.type) {
      case "video":
        return "#2563eb";
      case "image":
        return "#0ea5e9";
      case "text":
        return "#f59e0b";
      case "shape":
        return "#10b981";
      case "audio":
        return "#16a34a";
      default:
        return "#4b5563";
    }
  };

  const ghostOpacity = 1; // Always visible now.

  const setRefs = (node: HTMLElement | null) => {
    setNodeRef(node);
    domRef.current = node;
  };

  return (
    <ClipRoot
      ref={setRefs}
      {...listeners}
      {...attributes}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        const isMulti = e.ctrlKey || e.metaKey || e.shiftKey;
        useTimelineStore.getState().selectClip(clip.id, isMulti);
      }}
      elevation={2}
      style={
        {
          // --- Dynamic Visuals (Hybrid approach) ---
          backgroundColor: getBackgroundColor(),
          cursor: isOverlay ? "grabbing" : "grab",
          border: "1px solid rgba(255,255,255,0.2)",
          outline: isSelected ? "2px solid #fff" : "2px solid transparent",
          outlineOffset: "-1px",
          opacity: isOverlay
            ? 1
            : isTrackVisible
              ? ghostOpacity
              : ghostOpacity * 0.3,
          zIndex: isDragging ? 38 : isOverlay ? 999 : isSelected ? 10 : 1,
          boxShadow: isDragging ? "0 4px 8px rgba(0,0,0,0.5)" : "none",
          transition: isActive ? "none" : "box-shadow 0.2s, outline-color 0.1s",

          // --- Metrics & Positioning ---
          left: isOverlay
            ? "0px"
            : `calc(
              ${TRACK_HEADER_WIDTH}px + 
              (${baseLeft}px * var(--timeline-zoom, 1)) + 
              var(--drag-delta-x, 0px)
            )`,
          width: `calc(
          (${baseWidth}px * var(--timeline-zoom, 1)) + 
          var(--drag-delta-w, 0px)
        )`,
          top: topPos,
          // Apply transform directly from hook if available (priority) or handled by effect
          transform: transform
            ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
            : undefined,
        } as React.CSSProperties
      }
      data-testid="timeline-clip"
      data-selected={isSelected ? "true" : "false"}
      data-track-visible={isTrackVisible ? "true" : "false"}
    >
      <ThumbnailCanvas clip={clip} isDragging={isDragging} />
      {!isDragging && !isOverlay && (
        <SplineOverlay clip={clip as TimelineClipType} />
      )}
      {isSelected && !isDragging && !isOverlay && (
        <>
          <ResizeHandle
            id={`resize_left_${clip.id}`}
            clip={clip as TimelineClipType}
            side="left"
          />
          <ResizeHandle
            id={`resize_right_${clip.id}`}
            clip={clip as TimelineClipType}
            side="right"
          />
        </>
      )}

      <Typography
        variant="caption"
        noWrap
        sx={{ fontWeight: "bold", pointerEvents: "none" }}
      >
        {clip.name}
      </Typography>
      <Typography
        variant="caption"
        sx={{ fontSize: "0.6rem", opacity: 0.8, pointerEvents: "none" }}
      >
        {(clip.timelineDuration / TICKS_PER_SECOND).toFixed(2)}s
      </Typography>
    </ClipRoot>
  );
}

export const TimelineClipItem = memo(TimelineClipComponent);
