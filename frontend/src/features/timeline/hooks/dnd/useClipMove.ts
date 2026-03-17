import React, { useState, useEffect, useRef } from "react";
import type { DragMoveEvent, DragEndEvent } from "@dnd-kit/core";
import { useTimelineStore } from "../../useTimelineStore";
import { useInteractionStore } from "../useInteractionStore";
import { useTimelineViewStore } from "../useTimelineViewStore";
import { resolveCollision, hasAnyCollision } from "../../utils/collision";
import {
  TRACK_HEADER_WIDTH,
  TRACK_HEIGHT,
  RULER_HEIGHT, // [!code ++]
  SNAP_THRESHOLD_PX,
} from "../../constants";
import type { TimelineClip, BaseClip } from "../../../../types/TimelineTypes";
import { getGhostClipPosition, GHOST_CLIP_HEIGHT } from "./dragGeometry";
import { getTrackTypeFromClipType } from "../../utils/formatting";
import { getMoveSnapCandidate } from "./snapUtils";
import { attachGenerationMask } from "../../utils/insertAssetToTimeline";
import { getAssetById } from "../../../userAssets";
import { useProjectStore } from "../../../project";
import {
  getTicksPerFrame,
  snapTickToFrame,
} from "../../../timelineSelection";

export const useClipMove = (
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
) => {
  // We access stores imperatively to avoid re-rendering the EditorLayout
  // every time the timeline state changes (which would happen if we subscribed here).
  const [insertGapIndex, setInsertGapIndex] = useState<number | null>(null);

  // Actions can be retrieved once (they are stable) or via getState()
  const { insertTrack, updateClipPosition, addClip } =
    useTimelineStore.getState();

  // Track exact mouse position to bypass dnd-kit's delta logic for new assets
  const cursorRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      cursorRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("pointermove", handlePointerMove, {
      capture: true,
    });
    return () =>
      window.removeEventListener("pointermove", handlePointerMove, {
        capture: true,
      });
  }, []);

  /**
   * Helper: Calculates the Viewport Rect (BoundingClientRect) of the currently dragged item.
   * This unifies logic for "Existing Clips" (tracked by dnd-kit) and "New Assets" (tracked by cursor).
   */
  const getDraggedRect = (
    active: DragMoveEvent["active"],
    activatorEvent: Event | null,
    delta: { x: number; y: number },
  ) => {
    // Case 1: New Asset (Sidebar -> Timeline)
    // We must manually calculate where the "Ghost" overlay is based on cursor
    if (active.data.current?.type === "asset") {
      // Use Ground Truth cursor if available
      if (cursorRef.current) {
        const { x: currentX, y: currentY } = cursorRef.current;
        const clip = active.data.current.clip as BaseClip;
        const width = useTimelineViewStore
          .getState()
          .ticksToPx(clip.timelineDuration);
        const height = GHOST_CLIP_HEIGHT;

        // Use shared geometry to get Viewport X/Y of the top-left corner
        const { x, y } = getGhostClipPosition(currentX, currentY, height);

        return {
          top: y,
          bottom: y + height,
          left: x,
          right: x + width,
          height,
          width,
        };
      }

      // Fallback: Use dnd-kit delta (legacy behavior)
      if (activatorEvent) {
        const activator = activatorEvent as MouseEvent | TouchEvent;
        const isPointer = "clientX" in activator || "touches" in activator;

        if (isPointer) {
          const clientX =
            "clientX" in activator
              ? (activator as MouseEvent).clientX
              : ((activator as TouchEvent).touches?.[0]?.clientX ?? 0);
          const clientY =
            "clientY" in activator
              ? (activator as MouseEvent).clientY
              : ((activator as TouchEvent).touches?.[0]?.clientY ?? 0);

          // Note: We use delta to emulate the exact position logic of the overlay
          const currentX = clientX + delta.x;
          const currentY = clientY + delta.y;

          const clip = active.data.current.clip as BaseClip;
          const width = useTimelineViewStore
            .getState()
            .ticksToPx(clip.timelineDuration);
          const height = GHOST_CLIP_HEIGHT;

          // Use shared geometry to get Viewport X/Y of the top-left corner
          const { x, y } = getGhostClipPosition(currentX, currentY, height);

          return {
            top: y,
            bottom: y + height,
            left: x,
            right: x + width,
            height,
            width,
          };
        }
      }
    }

    // Case 2: Existing Clip (Timeline -> Timeline)
    // Dnd-kit tracks this accurately in `translated`
    return active.rect.current.translated;
  };

  const resolveMoveSnap = (startTicks: number, durationTicks: number) => {
    const interaction = useInteractionStore.getState();

    if (!interaction.snappingEnabled || interaction.snapPoints.length === 0) {
      interaction.clearSnapPreview();
      return null;
    }

    const candidate = getMoveSnapCandidate(
      startTicks,
      durationTicks,
      interaction.snapPoints,
      useTimelineViewStore.getState().ticksToPx,
      SNAP_THRESHOLD_PX,
    );

    if (!candidate) {
      interaction.clearSnapPreview();
      return null;
    }

    interaction.setSnapPreview({
      tick: candidate.snapTick,
      snappedStartTicks: Math.max(0, candidate.snappedStartTicks),
    });

    return Math.max(0, candidate.snappedStartTicks);
  };

  // 1. Handle Visual Gap Feedback (Interstitial)
  const handleMove = (event: DragMoveEvent) => {
    if (useTimelineStore.getState().selectedClipIds.length > 1) {
      if (insertGapIndex !== null) setInsertGapIndex(null);
      useInteractionStore.getState().clearSnapPreview();
      return;
    }

    const { active, over, activatorEvent, delta } = event;

    // --- DETECT IF OVER TIMELINE (For Overlay Switching) ---
    let isOverTimeline = false;
    if (over && over.data.current?.type !== "asset-slot") {
      isOverTimeline = true;
    } else if (scrollContainerRef.current && cursorRef.current) {
      const container = scrollContainerRef.current;
      const rect = container.getBoundingClientRect();
      const { y: cursorY } = cursorRef.current;

      // Check bounds: Include specific buffer (e.g., 50px) for the Toolbar above the tracks
      // logic: rect.top is the start of tracks. Toolbar is above it.
      const TOOLBAR_BUFFER = 50;
      if (cursorY >= rect.top - TOOLBAR_BUFFER && cursorY <= rect.bottom) {
        isOverTimeline = true;
      }
    }

    // Sync to store (only if changed to avoid thrashing)
    if (useInteractionStore.getState().isOverTimeline !== isOverTimeline) {
      useInteractionStore.getState().setIsOverTimeline(isOverTimeline);
    }
    // --------------------------------------------------------

    // We rely primarily on what we are hovering OVER
    // FALBACK: If 'over' is null (e.g. Asset Drag from outer context), calculate track index manually
    let trackIndex = -1;
    let trackRectVal: DOMRect | null = null;

    if (over) {
      trackIndex = useTimelineStore
        .getState()
        .tracks.findIndex((t) => t.id === over.id);
      trackRectVal = new DOMRect(
        over.rect.left,
        over.rect.top,
        over.rect.width,
        over.rect.height,
      );
    }

    // If dnd-kit didn't find a track, try coordinate math if we have the container
    if (trackIndex === -1 && scrollContainerRef.current && cursorRef.current) {
      const container = scrollContainerRef.current;
      const rect = container.getBoundingClientRect();
      const { y: cursorY } = cursorRef.current;

      // Check if inside container vertically
      if (cursorY >= rect.top && cursorY <= rect.bottom) {
        // [FIX] Subtract RULER_HEIGHT to account for the ruler occupying the top space
        const relativeY =
          cursorY - rect.top + container.scrollTop - RULER_HEIGHT; // [!code ++]

        if (relativeY >= 0) {
          const calculatedIndex = Math.floor(relativeY / TRACK_HEIGHT);
          const tracks = useTimelineStore.getState().tracks;
          if (calculatedIndex < tracks.length) {
            trackIndex = calculatedIndex;
            // Synthesize a rect for the logic below
            // [FIX] Add RULER_HEIGHT back when calculating absolute screen coordinates
            const top =
              rect.top -
              container.scrollTop +
              RULER_HEIGHT +
              trackIndex * TRACK_HEIGHT; // [!code ++]
            trackRectVal = new DOMRect(
              rect.left,
              top,
              rect.width,
              TRACK_HEIGHT,
            );
          }
        }
      }
    }

    // If still no track, bail out
    if (trackIndex === -1 || !trackRectVal) {
      setInsertGapIndex(null);
      useInteractionStore.getState().clearSnapPreview();
      return;
    }

    // Get Viewport Geometries
    const dragRect = getDraggedRect(active, activatorEvent, delta);

    // FIX: When dragging a new asset (from outside the scroll container),
    // over.rect reflects the Layout position (unscrolled), while dragRect is Viewport.
    // We must manually compensate for scrollTop to align them in Viewport space.
    const trackRect = trackRectVal;

    if (!dragRect || !trackRect) {
      useInteractionStore.getState().clearSnapPreview();
      return;
    }

    // Geometric Logic:
    // We want to insert a track if the dragged item is "hovering between" rows.
    // We define this as: The Vertical Center of the dragged item is close to a Track Boundary.
    const dragCenterY = dragRect.top + dragRect.height / 2;
    const distToTop = Math.abs(dragCenterY - trackRect.top);
    const distToBottom = Math.abs(dragCenterY - trackRect.bottom);

    // Threshold: How close to the edge (in px) to trigger insertion?
    // Using 35% of the track height creates a comfortable "middle third" logic
    // where the top 35% triggers "Above", bottom 35% triggers "Below", and middle 30% is "On Gap".
    const INSERT_THRESHOLD = trackRect.height * 0.35;

    if (distToTop < INSERT_THRESHOLD) {
      // Hovering Top Edge -> Insert at current index
      setInsertGapIndex(trackIndex);
    } else if (distToBottom < INSERT_THRESHOLD) {
      // Hovering Bottom Edge -> Insert at next index
      setInsertGapIndex(trackIndex + 1);
    } else {
      // Hovering Middle -> Drop ON the track
      setInsertGapIndex(null);
    }

    // --- NEW: Calculate Projected End Time for Timeline Expansion ---
    // This allows the TimelineContainer to expand the scrollable area
    // if we drag an asset past the current content end.

    if (scrollContainerRef.current) {
      const containerRect = scrollContainerRef.current.getBoundingClientRect();
      const scrollLeft = scrollContainerRef.current.scrollLeft;

      // X = (ViewportX - ContainerLeft) + ScrollLeft - HeaderOffset
      const relativeX =
        dragRect.left - containerRect.left + scrollLeft - TRACK_HEADER_WIDTH;

      const projectedStartTicks = Math.max(
        0,
        useTimelineViewStore.getState().pxToTicks(relativeX),
      );

      // Get timelineDuration from the active clip
      // Note: active.data.current.clip is reliable for both Assets and Clips
      const clipDuration = (active.data.current?.clip as BaseClip)
        .timelineDuration;
      const snappedStartTicks = resolveMoveSnap(
        projectedStartTicks,
        clipDuration,
      );
      const effectiveStartTicks = snappedStartTicks ?? projectedStartTicks;
      const projectedEndTicks = effectiveStartTicks + clipDuration;

      useInteractionStore.getState().updateProjectedEndTime(projectedEndTicks);
    }
  };

  // 2. Handle Commit (Ordinary)
  const handleEnd = (
    event: DragEndEvent,
    clip: BaseClip | TimelineClip,
    snapStartTicks: number | null = null,
  ) => {
    const { over, activatorEvent, delta } = event;

    // --- 1. Calculate Time (Horizontal) ---
    // We still need relative coordinates for Time, but we must correct for Scroll Left
    const dragRect = getDraggedRect(event.active, activatorEvent, delta);

    if (!dragRect || !scrollContainerRef.current) return;

    const containerRect = scrollContainerRef.current.getBoundingClientRect();
    const scrollLeft = scrollContainerRef.current.scrollLeft;

    // X = (ViewportX - ContainerLeft) + ScrollLeft - HeaderOffset
    const relativeX =
      dragRect.left - containerRect.left + scrollLeft - TRACK_HEADER_WIDTH;
    const unsnappedStartTicks = Math.max(
      0,
      useTimelineViewStore.getState().pxToTicks(relativeX),
    );
    const ticksPerFrame = getTicksPerFrame(
      useProjectStore.getState().config.fps,
    );
    // Snap to frame grid; clip-to-clip snap (snapStartTicks) takes priority
    const startTicks = snapStartTicks != null
      ? snapStartTicks
      : Math.max(0, snapTickToFrame(unsnappedStartTicks, ticksPerFrame));

    // --- 2. Calculate Track (Vertical) ---
    // We prioritize the gap index calculated during the move phase
    let targetTrackId = "";
    let shouldInsert = false;

    if (insertGapIndex !== null) {
      // Case A: Insertion
      targetTrackId = insertTrack(insertGapIndex);
      shouldInsert = true;
    } else {
      // Case B: Drop on existing track
      if (over) {
        targetTrackId = over.id as string;
      }

      // Fallback: Coordinate Math (for Context Isolation)
      if (!targetTrackId && scrollContainerRef.current && cursorRef.current) {
        const container = scrollContainerRef.current;
        const rect = container.getBoundingClientRect();
        const { y: cursorY } = cursorRef.current;

        if (cursorY >= rect.top && cursorY <= rect.bottom) {
          // [FIX] Subtract RULER_HEIGHT here as well
          const relativeY =
            cursorY - rect.top + container.scrollTop - RULER_HEIGHT; // [!code ++]

          if (relativeY >= 0) {
            const trackIndex = Math.floor(relativeY / TRACK_HEIGHT);
            const tracks = useTimelineStore.getState().tracks;
            if (trackIndex >= 0 && trackIndex < tracks.length) {
              targetTrackId = tracks[trackIndex].id;
            }
          }
        }
      }

      if (!targetTrackId) {
        // Case C: Dropped in empty space? Fallback or Cancel
        setInsertGapIndex(null);
        return;
      }
    }

    const isNewAsset = !("trackId" in clip);

    const tracks = useTimelineStore.getState().tracks;
    const selectedClipIds = useTimelineStore.getState().selectedClipIds;
    const clips = useTimelineStore.getState().clips;

    // --- SINGLE CLIP LOGIC ---
    if (isNewAsset || selectedClipIds.length <= 1) {
      if (!shouldInsert) {
        // Check against explicit Track Type
        const targetTrack = tracks.find((t) => t.id === targetTrackId);
        if (
          targetTrack?.type &&
          targetTrack.type !== getTrackTypeFromClipType(clip.type)
        ) {
          setInsertGapIndex(null);
          return;
        }
      }

      const finalStartTicks = resolveCollision(
        clip.id,
        startTicks,
        clip.timelineDuration,
        targetTrackId,
        clips,
      );

      if (finalStartTicks !== null) {
        if (isNewAsset) {
          const newClip = {
            ...(clip as BaseClip),
            trackId: targetTrackId,
            start: finalStartTicks,
          } as TimelineClip;
          addClip(newClip);
          if (newClip.assetId) {
            const asset = getAssetById(newClip.assetId);
            if (asset) {
              attachGenerationMask(newClip.id, asset);
            }
          }
        } else {
          updateClipPosition(clip.id, finalStartTicks, targetTrackId);
        }
      }

      setInsertGapIndex(null);
      return;
    }

    // Multi-Selection Logic (simplified for brevity, assumes standard offset logic)
    // ... [Multi-selection logic remains largely similar, but ensure it uses targetTrackId] ...
    // For this specific fix, we focus on the single/new asset positioning which was broken.

    // Fallback for multi-select if needed:
    const leaderClip = clip as TimelineClip;
    const leaderOriginalTrackIndex = tracks.findIndex(
      (t) => t.id === leaderClip.trackId,
    );
    const targetTrackIndex = tracks.findIndex((t) => t.id === targetTrackId);

    if (targetTrackIndex === -1) {
      setInsertGapIndex(null);
      return;
    }

    const trackDelta = targetTrackIndex - leaderOriginalTrackIndex;
    const deltaTicks = startTicks - leaderClip.start; // Calculate ticks delta based on drop position

    // Apply updates...
    const selectedClips = clips.filter(
      (c) => selectedClipIds.includes(c.id) && c.type !== "mask",
    );

    // 1. Validate all moves first (Atomic Commit)
    for (const clip of selectedClips) {
      const newStart = snapTickToFrame(
        Math.max(0, clip.start + deltaTicks),
        ticksPerFrame,
      );
      const currentTrackIndex = tracks.findIndex((t) => t.id === clip.trackId);
      const newTrackIndex = currentTrackIndex + trackDelta;

      if (newTrackIndex < 0 || newTrackIndex >= tracks.length) {
        setInsertGapIndex(null);
        return;
      }

      // Check for type compatibility on the target track
      const targetTrack = tracks[newTrackIndex];
      if (
        targetTrack.type &&
        targetTrack.type !== getTrackTypeFromClipType(clip.type)
      ) {
        setInsertGapIndex(null);
        return;
      }

      if (
        hasAnyCollision(
          newStart,
          clip.timelineDuration,
          tracks[newTrackIndex].id,
          selectedClipIds,
          clips,
        )
      ) {
        setInsertGapIndex(null);
        return;
      }
    }

    // 2. Execute updates
    selectedClips.forEach((clip) => {
      const newStart = snapTickToFrame(
        Math.max(0, clip.start + deltaTicks),
        ticksPerFrame,
      );
      const currentTrackIndex = tracks.findIndex((t) => t.id === clip.trackId);
      const newTrackIndex = currentTrackIndex + trackDelta;

      updateClipPosition(clip.id, newStart, tracks[newTrackIndex].id);
    });

    setInsertGapIndex(null);
  };

  return {
    insertGapIndex,
    setInsertGapIndex,
    handleMove,
    handleEnd,
  };
};
