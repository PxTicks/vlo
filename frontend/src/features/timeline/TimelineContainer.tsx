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
import { snapTickToFrameGrid } from "../../core/time/frameGrid";
import { mediaSecondsToTickExact } from "../renderer/utils/mediaTime";
import {
  TRACK_HEIGHT,
  TRACK_HEADER_WIDTH,
  MIN_ZOOM,
  MAX_ZOOM,
  RULER_HEIGHT,
} from "./constants";
import { TimelineRuler } from "./components/TimelineRuler";
import { TimelinePlayhead } from "./components/TimelinePlayhead";
import { SelectionOverlay } from "./components/SelectionOverlay";
import { FrameSelectionOverlay } from "./components/FrameSelectionOverlay";
import { SamAudioExtractDialog } from "../samAudio";
import { playbackClock } from "../../core/playback/PlaybackClock";
import { type TimelineClip } from "../../types";
import type { TimelineClipOverlayDefinition } from "./clipOverlayApi";
import { useTimelineSelectionStore } from "../timelineSelection";
import { useAssetBrowserSelectionStore } from "../userAssets/useAssetBrowserSelectionStore";
import { useAssetBrowserRevealStore } from "../userAssets/useAssetBrowserRevealStore";
import { buildTimelineClipPresentationIndex } from "./utils/clipPresentation";
import { resolveTransitions } from "./model/transitionModel";
import { TransitionOverlay } from "../transitions/components/TransitionOverlay";

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

export interface TimelineContainerProps {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  insertGapIndex?: number | null;
  clipOverlays?: readonly TimelineClipOverlayDefinition[];
}

function TimelineContainerComponent({
  scrollContainerRef,
  insertGapIndex: externalInsertGapIndexProp,
  clipOverlays = [],
}: TimelineContainerProps) {
  const {
    tracks,
    clips,
    selectClip,
    toggleTrackVisibility,
    toggleTrackMute,
    transitions,
    selectedTransitionId,
    selectTransition,
  } = useTimelineStore(
    useShallow((state) => ({
      tracks: state.tracks,
      clips: state.clips,
      selectClip: state.selectClip,
      toggleTrackVisibility: state.toggleTrackVisibility,
      toggleTrackMute: state.toggleTrackMute,
      transitions: state.transitions,
      selectedTransitionId: state.selectedTransitionId,
      selectTransition: state.selectTransition,
    })),
  );
  const timelineClips = React.useMemo(
    () => clips.filter((clip) => clip.type !== "mask"),
    [clips],
  );
  const projectFps = useProjectStore((state) => state.config.fps);
  const resolvedTransitions = React.useMemo(
    () => resolveTransitions(transitions, tracks, clips, projectFps),
    [clips, projectFps, tracks, transitions],
  );
  const clipPresentationById = React.useMemo(
    () => buildTimelineClipPresentationIndex(tracks, clips, projectFps),
    [tracks, clips, projectFps],
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
  const {
    interactionActiveClip,
    interactionOperation,
    interactionDeltaX,
    externalInsertGapIndex,
  } = useInteractionStore(
    useShallow((state) => ({
      interactionActiveClip: state.activeClip,
      interactionOperation: state.operation,
      interactionDeltaX: state.currentDeltaX,
      externalInsertGapIndex: state.externalInsertGapIndex,
    })),
  );
  const interactionSnapTick = useInteractionStore((state) => state.snapTick);
  const transformDropPreview = useInteractionStore(
    (state) => state.transformDropPreview,
  );
  const transitionDropPreview = useInteractionStore(
    (state) => state.transitionDropPreview,
  );
  const resolvedExternalInsertGapIndex =
    externalInsertGapIndexProp !== undefined
      ? externalInsertGapIndexProp
      : externalInsertGapIndex;

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
      (max, clip) =>
        Math.max(
          max,
          clipPresentationById.get(clip.id)?.end ??
            clip.start + clip.timelineDuration,
        ),
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
          const activePresentation = clipPresentationById.get(activeClip.id);
          const projectedDuration = Math.max(
            0,
            (activePresentation?.duration ?? activeClip.timelineDuration) +
              deltaTicks,
          );
          const projectedEnd =
            (activePresentation?.start ?? activeClip.start) + projectedDuration;
          maxClipEnd = Math.max(maxClipEnd, projectedEnd);
        }
      }
    } else if (transformDropPreview !== null) {
      // A transform-card drag doesn't go through startDrag/activeClip, so honor
      // its projected footprint end here to expand the timeline as it nears the
      // current right edge.
      const projectedEndTime = useInteractionStore.getState().projectedEndTime;
      if (projectedEndTime !== null) {
        maxClipEnd = Math.max(maxClipEnd, projectedEndTime);
      }
    }

    const minDurationTicks = mediaSecondsToTickExact(15);
    const bufferTicks = mediaSecondsToTickExact(10);
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

  // Undo/redo, copy/paste, and delete shortcuts are host keybindings routed
  // through the command table (features/timeline/hostCommands.ts); their
  // "only handle when applicable" semantics live in each command's `when`
  // clause over the timeline context keys.

  const handleTimelineInteractionCapture = useCallback(() => {
    const assetBrowserRevealState = useAssetBrowserRevealStore.getState();
    if (assetBrowserRevealState.revealRequest !== null) {
      assetBrowserRevealState.clearRevealRequest();
    }

    const assetBrowserSelectionState = useAssetBrowserSelectionStore.getState();
    if (assetBrowserSelectionState.selectedAssetIds.length > 0) {
      assetBrowserSelectionState.clearSelection();
    }
  }, []);

  return (
    <Box sx={containerStyles}>
      <TimelineToolbar />
      <Box
        sx={scrollStyles}
        ref={setScrollRef}
        onClickCapture={handleTimelineInteractionCapture}
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

            const newTime = pxToTicks(timelineX);

            const fps = useProjectStore.getState().config.fps;
            const snappedTicks = snapTickToFrameGrid(newTime, fps);

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
                  : resolvedExternalInsertGapIndex
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
              {/* Interstitial: a new adjustment track will be inserted at a
                  boundary — show ONLY the gap line (no footprint, since the
                  track doesn't exist yet). */}
              {transformDropPreview?.kind === "gap" ? (
                <HoverGapIndicator
                  gapIndex={transformDropPreview.gapIndex}
                  trackHeight={TRACK_HEIGHT}
                />
              ) : null}
              {/* Footprint of the 5s adjustment clip at the row/tick it lands
                  on (an existing adjustment lane, or a freshly created one). */}
              {transformDropPreview?.kind === "rect" ? (
                <Box
                  data-testid="transform-adjustment-drop-preview"
                  data-compatible={
                    transformDropPreview.compatible ? "true" : "false"
                  }
                  sx={{
                    position: "absolute",
                    top:
                      RULER_HEIGHT +
                      transformDropPreview.trackIndex * TRACK_HEIGHT +
                      5,
                    left:
                      TRACK_HEADER_WIDTH +
                      ticksToPx(transformDropPreview.startTick),
                    width: Math.max(
                      24,
                      ticksToPx(transformDropPreview.durationTicks),
                    ),
                    height: TRACK_HEIGHT - 10,
                    borderRadius: "4px",
                    border: transformDropPreview.compatible
                      ? "2px dashed rgba(77, 171, 245, 0.9)"
                      : "2px dashed rgba(244, 67, 54, 0.85)",
                    bgcolor: transformDropPreview.compatible
                      ? "rgba(77, 171, 245, 0.14)"
                      : "rgba(244, 67, 54, 0.1)",
                    boxShadow: transformDropPreview.compatible
                      ? "0 0 0 1px rgba(77, 171, 245, 0.2)"
                      : "0 0 0 1px rgba(244, 67, 54, 0.18)",
                    zIndex: 12,
                  }}
                />
              ) : null}
              {transitionDropPreview ? (
                <Box
                  data-testid="transition-drop-preview"
                  sx={{
                    position: "absolute",
                    top:
                      RULER_HEIGHT +
                      transitionDropPreview.topTrackIndex * TRACK_HEIGHT +
                      5,
                    left:
                      TRACK_HEADER_WIDTH +
                      ticksToPx(transitionDropPreview.startTick),
                    width: Math.max(
                      20,
                      ticksToPx(
                        transitionDropPreview.endTick -
                          transitionDropPreview.startTick,
                      ),
                    ),
                    height: TRACK_HEIGHT * 2 - 10,
                    borderRadius: 1,
                    border: "2px dashed rgba(77,171,245,0.95)",
                    bgcolor: "rgba(77,171,245,0.14)",
                    zIndex: 19,
                  }}
                />
              ) : null}
              {timelineClips.map((clip) => (
                <TimelineClipItem
                  key={clip.id}
                  clip={clip}
                  presentation={clipPresentationById.get(clip.id)}
                  clipOverlays={clipOverlays}
                />
              ))}
              {resolvedTransitions.map((resolved) => (
                <TransitionOverlay
                  key={resolved.transition.id}
                  resolved={resolved}
                  selected={selectedTransitionId === resolved.transition.id}
                  onSelect={selectTransition}
                />
              ))}
            </Box>
          </Box>
        </DndContext>
      </Box>
      <SamAudioExtractDialog />
    </Box>
  );
}

export const TimelineContainer = React.memo(TimelineContainerComponent);
