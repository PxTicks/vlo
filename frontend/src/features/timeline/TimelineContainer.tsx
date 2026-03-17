import React, { useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { Box } from "@mui/material";
import { useShallow } from "zustand/react/shallow";
import {
  DndContext,
  pointerWithin,
  useSensors,
  useSensor,
  PointerSensor,
} from "@dnd-kit/core";

// Hooks
import { useTimelineStore } from "./useTimelineStore";
import { useProjectStore } from "../project/useProjectStore";
import { useTimelineViewStore } from "./hooks/useTimelineViewStore";
import { useTimelineInternalDrag } from "./hooks/dnd/useTimelineInternalDrag";
import { useInteractionStore } from "./hooks/useInteractionStore";

// Components
import { TimelineRow } from "./components/TimelineRow";
import { TimelineClipItem } from "./components/TimelineClip";
import { TimelineToolbar } from "./components/TimelineToolbar";
import { HoverGapIndicator } from "./components/HoverGapIndicator";
import {
  TRACK_HEIGHT,
  TICKS_PER_SECOND,
  TRACK_HEADER_WIDTH,
  PIXELS_PER_SECOND,
  MIN_ZOOM,
  MAX_ZOOM,
  RULER_HEIGHT,
} from "./constants";
import { TimelineRuler } from "./components/TimelineRuler";
import { TimelinePlayhead } from "./components/TimelinePlayhead";
import { SelectionOverlay } from "./components/SelectionOverlay";
import { FrameSelectionOverlay } from "./components/FrameSelectionOverlay";
import { playbackClock } from "../player/services/PlaybackClock";
import { type TimelineClip } from "../../types";
import { useTimelineSelectionStore } from "../timelineSelection";

const containerStyles = {
  width: "100%",
  height: "100%",
  bgcolor: "#111",
  borderTop: "2px solid #444",
  display: "flex",
  flexDirection: "column" as const,
};

const scrollStyles = {
  flexGrow: 1,
  overflowY: "auto",
  overflowX: "auto",
  position: "relative",
  scrollbarWidth: "thin",
  "&::-webkit-scrollbar": { height: "8px", backgroundColor: "#222" },
  "&::-webkit-scrollbar-thumb": {
    backgroundColor: "#555",
    borderRadius: "4px",
  },
};

interface TimelineContainerProps {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  insertGapIndex: number | null; // This comes from the External Asset Drag
}

function TimelineContainerComponent({
  scrollContainerRef,
  insertGapIndex: externalInsertGapIndex,
}: TimelineContainerProps) {
  const {
    tracks,
    clips,
    selectClip,
    removeClip,
    copySelectedClip,
    pasteCopiedClipAbove,
    undo,
    redo,
    toggleTrackVisibility,
    toggleTrackMute,
    selectedClipIds,
  } = useTimelineStore(
    useShallow((state) => ({
      tracks: state.tracks,
      clips: state.clips,
      selectClip: state.selectClip,
      removeClip: state.removeClip,
      copySelectedClip: state.copySelectedClip,
      pasteCopiedClipAbove: state.pasteCopiedClipAbove,
      undo: state.undo,
      redo: state.redo,
      toggleTrackVisibility: state.toggleTrackVisibility,
      toggleTrackMute: state.toggleTrackMute,
      selectedClipIds: state.selectedClipIds,
    })),
  );
  const timelineClips = React.useMemo(
    () => clips.filter((clip) => clip.type !== "mask"),
    [clips],
  );

  const { zoomScale, setZoomScale, ticksToPx, pxToTicks, setScrollContainer } =
    useTimelineViewStore(
      useShallow((state) => ({
        zoomScale: state.zoomScale,
        setZoomScale: state.setZoomScale,
        ticksToPx: state.ticksToPx,
        pxToTicks: state.pxToTicks,
        setScrollContainer: state.setScrollContainer,
      })),
    );

  // --- INTERNAL DND SETUP ---
  const {
    handleInternalDragStart,
    handleInternalDragMove,
    handleInternalDragEnd,
    insertGapIndex: internalInsertGapIndex,
  } = useTimelineInternalDrag(scrollContainerRef);

  // --- INTERACTION STATE (For expanding timeline during drag) ---
  const { interactionActiveClip, interactionOperation, interactionDeltaX } =
    useInteractionStore(
      useShallow((state) => ({
        interactionActiveClip: state.activeClip,
        interactionOperation: state.operation,
        interactionDeltaX: state.currentDeltaX,
      })),
    );
  const interactionSnapTick = useInteractionStore((state) => state.snapTick);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 3,
      },
    }),
  );

  // Ref to store the exact time and mouse position *before* the zoom update
  const zoomAnchorRef = useRef<{
    mouseOffsetX: number;
    anchorTimeTicks: number;
  } | null>(null);

  // Register scroll container for virtualization
  const setScrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      setScrollContainer(node);
      if (scrollContainerRef) {
        (
          scrollContainerRef as React.MutableRefObject<HTMLDivElement | null>
        ).current = node;
      }
    },
    [scrollContainerRef, setScrollContainer],
  );

  // Wheel Zoom Handler
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();

        // 1. Calculate Mouse Position relative to container viewport
        const rect = container.getBoundingClientRect();
        const mouseOffsetX = e.clientX - rect.left;

        // 2. Calculate the specific "Time" (ticks) under the mouse cursor right now
        const currentScrollLeft = container.scrollLeft;
        const timelineX = currentScrollLeft + mouseOffsetX - TRACK_HEADER_WIDTH;
        const anchorTimeTicks = pxToTicks(timelineX);

        // 3. Store this anchor point
        zoomAnchorRef.current = { mouseOffsetX, anchorTimeTicks };

        // 4. Update the zoom scale
        const zoomSensitivity = 0.01;
        const delta = -e.deltaY * zoomSensitivity;
        const newScale = Math.max(
          MIN_ZOOM,
          Math.min(zoomScale + delta, MAX_ZOOM),
        );

        setZoomScale(newScale);
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [scrollContainerRef, zoomScale, setZoomScale, pxToTicks]);

  // Layout Effect: Restore the scroll position to align the anchor time
  useLayoutEffect(() => {
    if (zoomAnchorRef.current && scrollContainerRef.current) {
      const { mouseOffsetX, anchorTimeTicks } = zoomAnchorRef.current;

      // 1. Calculate where that time is located *now* (with the new zoom scale)
      // ticksToPx will use the updated zoomScale from the store
      const newTimelineX = ticksToPx(anchorTimeTicks);

      // 2. Adjust scrollLeft so that the timeline point is back under the mouse
      const newScrollLeft = newTimelineX - mouseOffsetX + TRACK_HEADER_WIDTH;

      scrollContainerRef.current.scrollLeft = newScrollLeft;

      // Reset
      zoomAnchorRef.current = null;
    }
  }, [zoomScale, scrollContainerRef, ticksToPx]);

  const calculateTimelineWidth = () => {
    let maxClipEnd = timelineClips.reduce(
      (max, clip) => Math.max(max, clip.start + clip.timelineDuration),
      0,
    );

    // If dragging, check if the projected position exceeds the current max
    if (interactionActiveClip) {
      // FIXED: Use the accurate projectedEndTime calculated in useClipMove
      // This accounts for scroll position and container geometry, unlike simple delta math.
      const interactionStore = useInteractionStore.getState();

      if (
        interactionOperation === "move" &&
        interactionStore.projectedEndTime !== null
      ) {
        maxClipEnd = Math.max(maxClipEnd, interactionStore.projectedEndTime);
      } else if (interactionDeltaX) {
        // Fallback or Resize operations (Resize logic remains local for now)
        const deltaTicks = pxToTicks(interactionDeltaX);
        const activeClip = interactionActiveClip as TimelineClip;

        if (interactionOperation === "resize_right") {
          const projectedDuration = Math.max(
            0,
            activeClip.timelineDuration + deltaTicks,
          );
          const projectedEnd = activeClip.start + projectedDuration;
          maxClipEnd = Math.max(maxClipEnd, projectedEnd);
        }
      }
    }

    const minDurationTicks = 15 * TICKS_PER_SECOND;
    const bufferTicks = 10 * TICKS_PER_SECOND;
    const totalDurationTicks = Math.max(
      minDurationTicks,
      maxClipEnd + bufferTicks,
    );
    return ticksToPx(totalDurationTicks);
  };

  const timelineWidth = calculateTimelineWidth();
  const snapLineLeft =
    interactionSnapTick === null
      ? null
      : TRACK_HEADER_WIDTH + ticksToPx(interactionSnapTick);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      )
        return;

      const isShortcut = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (isShortcut && key === "c") {
        if (copySelectedClip()) e.preventDefault();
        return;
      }

      if (isShortcut && key === "v") {
        if (pasteCopiedClipAbove()) e.preventDefault();
        return;
      }

      if (isShortcut && key === "z") {
        const wasHandled = e.shiftKey ? redo() : undo();
        if (wasHandled) e.preventDefault();
        return;
      }

      if (isShortcut && key === "y") {
        if (redo()) e.preventDefault();
        return;
      }

      if (selectedClipIds.length === 0) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        selectedClipIds.forEach((id) => removeClip(id));
        selectClip(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    selectedClipIds,
    removeClip,
    selectClip,
    copySelectedClip,
    pasteCopiedClipAbove,
    undo,
    redo,
  ]);

  return (
    <Box sx={containerStyles}>
      <TimelineToolbar />
      <Box
        sx={scrollStyles}
        ref={setScrollRef}
        onClick={(e) => {
          // Suppress click-to-seek in selection mode
          if (useTimelineSelectionStore.getState().selectionMode) return;

          const target = e.target as Element;
          if (
            target.closest('[data-testid="timeline-body"]') ||
            target === e.currentTarget
          ) {
            selectClip(null);
          }

          if (scrollContainerRef.current) {
            const rect = scrollContainerRef.current.getBoundingClientRect();
            const scrollLeft = scrollContainerRef.current.scrollLeft;
            const clickX = e.clientX - rect.left;
            const timelineX = clickX + scrollLeft - TRACK_HEADER_WIDTH;

            const newTime =
              (timelineX / zoomScale / PIXELS_PER_SECOND) * TICKS_PER_SECOND;

            const fps = useProjectStore.getState().config.fps;
            const ticksPerFrame = TICKS_PER_SECOND / fps;
            const snappedTicks =
              Math.round(newTime / ticksPerFrame) * ticksPerFrame;

            playbackClock.setTime(Math.max(0, snappedTicks));
          }
        }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          autoScroll={{
            acceleration: 25,
            interval: 5,
          }}
          onDragStart={handleInternalDragStart}
          onDragMove={handleInternalDragMove}
          onDragEnd={handleInternalDragEnd}
        >
          <Box
            sx={{
              position: "relative",
              minHeight: "100%",
              display: "flex",
              flexDirection: "column",
              minWidth: timelineWidth,
              "--timeline-zoom": zoomScale,
            }}
          >
            <TimelineRuler scrollContainerRef={scrollContainerRef} />
            <TimelinePlayhead />
            <SelectionOverlay />
            <FrameSelectionOverlay />
            {/* 
              CRITICAL: Render snap indicator unconditionally using `display: block|none`. 
              Do NOT conditionally unmount this `Box` (e.g. `{snapLineLeft !== null && <Box />}`).
              Because it lacks a 'key' and is rendered alongside dynamically mapped children (TimelineRows), 
              conditionally inserting it shifts the React sibling index of all subsequent DOM elements.
              This index shift causes React to violently unmount and remount the actively dragged TimelineClip,
              resetting its CSS transform state to 0 for a frame and causing severe flickering during the drag.
            */}
            <Box
              data-testid="timeline-snap-indicator"
              sx={{
                position: "absolute",
                top: `${RULER_HEIGHT}px`,
                bottom: 0,
                left: snapLineLeft !== null ? `${snapLineLeft}px` : 0,
                width: "1px",
                bgcolor: "#fbc02d",
                boxShadow: "0 0 0 1px rgba(251, 192, 45, 0.35)",
                zIndex: 25,
                pointerEvents: "none",
                display: snapLineLeft !== null ? "block" : "none",
              }}
            />

            {/* Show Gap Indicator if EITHER internal move OR external asset drag requests it */}
            <HoverGapIndicator
              gapIndex={
                internalInsertGapIndex !== null
                  ? internalInsertGapIndex
                  : externalInsertGapIndex
              }
              trackHeight={TRACK_HEIGHT}
            />

            {tracks.map((track, index) => (
              <TimelineRow
                key={track.id}
                track={track}
                index={index}
                onToggleVisibility={toggleTrackVisibility}
                onToggleMute={toggleTrackMute}
              />
            ))}

            <Box
              sx={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
              }}
            >
              {timelineClips.map((clip) => (
                <TimelineClipItem key={clip.id} clip={clip} />
              ))}
            </Box>
          </Box>
        </DndContext>
      </Box>
    </Box>
  );
}

export const TimelineContainer = React.memo(TimelineContainerComponent);
