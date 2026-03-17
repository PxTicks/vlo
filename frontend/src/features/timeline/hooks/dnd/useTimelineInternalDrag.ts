import type {
  DragStartEvent,
  DragMoveEvent,
  DragEndEvent,
} from "@dnd-kit/core";
import { useTimelineStore } from "../../useTimelineStore";
import { useInteractionStore } from "../useInteractionStore";
import { useTimelineViewStore } from "../useTimelineViewStore";
import {
  getMinimumClipDurationTicks,
  getResizeConstraints,
} from "../../utils/collision";
import {
  getDragStartSelectionAction,
  getDragEndClickAction,
} from "../../utils/selection";
import type { TimelineClip, BaseClip } from "../../../../types/TimelineTypes";
import { useClipMove } from "./useClipMove";
import { useClipResize } from "./useClipResize";
import React from "react";
import { useProjectStore } from "../../../project";

export const useTimelineInternalDrag = (
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
) => {
  // Movement Strategy (Shared with Asset Drag, but initialized here for internal moves)
  const moveStrategy = useClipMove(scrollContainerRef);
  const resizeStrategy = useClipResize();

  // Helper: Detect Modifier Keys (Ctrl/Cmd/Shift)
  const isMultiSelect = (event: Event | null) => {
    if (!event) return false;
    const e = event as MouseEvent;
    return e.ctrlKey || e.metaKey || e.shiftKey;
  };

  const handleDragStart = (event: DragStartEvent) => {
    const { active, activatorEvent } = event;
    const data = active.data.current;

    if (!data) return;

    // A. CLIP MOVEMENT & SELECTION
    if (data.type === "clip") {
      const clipId = data.clip.id;
      const isMulti = isMultiSelect(activatorEvent);
      const isSelected = useTimelineStore
        .getState()
        .selectedClipIds.includes(clipId);

      // Determine Selection Logic
      const action = getDragStartSelectionAction(clipId, isSelected, isMulti);

      // Execute Selection
      if (action.type === "SELECT_SINGLE")
        useTimelineStore.getState().selectClip(action.id, false);
      else if (action.type === "TOGGLE")
        useTimelineStore.getState().selectClip(action.id, true);

      // Initialize Drag
      useInteractionStore
        .getState()
        .startDrag(active.id as string, data.clip, "move");
    }

    // B. RESIZE HANDLING
    else if (data.type === "resize") {
      // Force select the clip being resized
      useTimelineStore.getState().selectClip(data.clip.id, false);

      const clip = data.clip as TimelineClip;
      const side = data.side as "left" | "right";
      const minDuration = getMinimumClipDurationTicks(
        useProjectStore.getState().config.fps,
      );

      // Calculate pixel constraints
      const constraints = getResizeConstraints(
        clip,
        useTimelineStore.getState().clips,
        side,
        minDuration,
      );
      const ticksToPx = useTimelineViewStore.getState().ticksToPx;

      let minPx = 0;
      let maxPx = 0;

      if (side === "left") {
        minPx = ticksToPx(constraints.min - clip.start);
        maxPx = ticksToPx(constraints.max - clip.start);
      } else {
        const currentEnd = clip.start + clip.timelineDuration;
        minPx = ticksToPx(constraints.min - currentEnd);
        maxPx = ticksToPx(constraints.max - currentEnd);
      }

      useInteractionStore
        .getState()
        .startDrag(
          active.id as string,
          clip,
          side === "left" ? "resize_left" : "resize_right",
          { minPx, maxPx },
        );
    }
  };

  const handleDragMove = (event: DragMoveEvent) => {
    const interaction = useInteractionStore.getState();
    const operation = interaction.operation;

    if (!operation) return;

    // Keep clip geometry updates in sync before any snap-preview state updates.
    interaction.updateDelta(event.delta.x, event.delta.y);

    if (operation === "move") {
      moveStrategy.handleMove(event);
    } else if (
      (operation === "resize_left" || operation === "resize_right") &&
      interaction.activeClip
    ) {
      resizeStrategy.handleMove(
        event,
        interaction.activeClip as TimelineClip,
        operation,
      );
      if (moveStrategy.insertGapIndex !== null) {
        moveStrategy.setInsertGapIndex(null);
      }
    } else {
      // Clean up gap indicator if we aren't in move mode
      if (moveStrategy.insertGapIndex !== null) {
        moveStrategy.setInsertGapIndex(null);
      }
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { delta, activatorEvent } = event;
    const interaction = useInteractionStore.getState();
    const operation = interaction.operation;
    const activeClip = interaction.activeClip;
    const snappedStartTicks = interaction.snappedStartTicks;
    const resizeSnapContext =
      operation === "resize_left" || operation === "resize_right"
        ? {
            enabled: interaction.snappingEnabled,
            points: interaction.snapPoints,
          }
        : undefined;

    interaction.stopDrag();

    if (!activeClip) return;

    const clip = activeClip as BaseClip | TimelineClip;

    if (operation === "move") {
      const wasDrag = Math.abs(delta.x) > 2 || Math.abs(delta.y) > 2;
      const isMulti = isMultiSelect(activatorEvent);
      const isSelected = useTimelineStore
        .getState()
        .selectedClipIds.includes(clip.id);

      const action = getDragEndClickAction(
        clip.id,
        wasDrag,
        isMulti,
        isSelected,
      );

      if (action.type === "SELECT_SINGLE") {
        // Only change selection on click, not drag completion
        useTimelineStore.getState().selectClip(action.id, false);
      }

      if (wasDrag) {
        moveStrategy.handleEnd(event, clip, snappedStartTicks);
      }
    } else if (operation === "resize_left" || operation === "resize_right") {
      resizeStrategy.handleEnd(
        event,
        clip as TimelineClip,
        operation as "resize_left" | "resize_right",
        resizeSnapContext,
      );
    }
  };

  return {
    handleInternalDragStart: handleDragStart,
    handleInternalDragMove: handleDragMove,
    handleInternalDragEnd: handleDragEnd,
    insertGapIndex: moveStrategy.insertGapIndex,
  };
};
