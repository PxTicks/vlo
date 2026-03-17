import type { DragEndEvent, DragMoveEvent } from "@dnd-kit/core";
import { useTimelineStore } from "../../useTimelineStore";
import { useTimelineViewStore } from "../useTimelineViewStore";
import {
  getMinimumClipDurationTicks,
  getResizeConstraints,
} from "../../utils/collision";
import { SNAP_THRESHOLD_PX } from "../../constants";
import { getResizedClipLeft, getResizedClipRight } from "../../utils/clipMath";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import { useInteractionStore } from "../useInteractionStore";
import { getEdgeSnapCandidate } from "./snapUtils";
import { useProjectStore } from "../../../project";
import {
  getTicksPerFrame,
  snapTickToFrame,
} from "../../../timelineSelection";

export const useClipResize = () => {
  // No subscriptions!

  const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(value, max));

  const handleMove = (
    event: DragMoveEvent,
    clip: TimelineClip,
    operation: "resize_left" | "resize_right",
  ) => {
    const minDuration = getMinimumClipDurationTicks(
      useProjectStore.getState().config.fps,
    );
    const interaction = useInteractionStore.getState();
    if (!interaction.snappingEnabled || interaction.snapPoints.length === 0) {
      interaction.clearSnapPreview();
      return;
    }

    const side = operation === "resize_left" ? "left" : "right";
    const deltaTicks = useTimelineViewStore.getState().pxToTicks(event.delta.x);
    const constraints = getResizeConstraints(
      clip,
      useTimelineStore.getState().clips,
      side,
      minDuration,
    );
    const ticksToPx = useTimelineViewStore.getState().ticksToPx;

    const hysteresisPx = SNAP_THRESHOLD_PX + 3;

    if (side === "left") {
      // 1. Calculate the raw unclamped position based on cursor
      const rawProposedStart = clip.start + deltaTicks;

      // 2. Find the best snap candidate for that raw position among *all* points
      const candidate = getEdgeSnapCandidate(
        rawProposedStart,
        interaction.snapPoints,
        ticksToPx,
        SNAP_THRESHOLD_PX,
      );

      // 3. Verify the candidate doesn't violate hard constraints
      // Also apply hysteresis if we were already snapping
      if (
        !candidate ||
        candidate.snapTick < constraints.min ||
        candidate.snapTick > constraints.max
      ) {
        if (interaction.snapTick !== null) {
          // Are we trying to break out of an existing snap?
          const keepCurrent =
            Math.abs(ticksToPx(rawProposedStart - interaction.snapTick)) <=
            hysteresisPx;
          if (keepCurrent) return;
        }
        interaction.clearSnapPreview();
        return;
      }

      interaction.setSnapPreview({
        tick: candidate.snapTick,
      });
      return;
    }

    // RIGHT SIDE
    const originalEnd = clip.start + clip.timelineDuration;
    const rawProposedEnd = originalEnd + deltaTicks;

    const candidate = getEdgeSnapCandidate(
      rawProposedEnd,
      interaction.snapPoints,
      ticksToPx,
      SNAP_THRESHOLD_PX,
    );

    if (
      !candidate ||
      candidate.snapTick < constraints.min ||
      candidate.snapTick > constraints.max
    ) {
      if (interaction.snapTick !== null) {
        const keepCurrent =
          Math.abs(ticksToPx(rawProposedEnd - interaction.snapTick)) <=
          hysteresisPx;
        if (keepCurrent) return;
      }
      interaction.clearSnapPreview();
      return;
    }

    interaction.setSnapPreview({
      tick: candidate.snapTick,
    });
  };

  const handleEnd = (
    event: DragEndEvent,
    clip: TimelineClip,
    operation: "resize_left" | "resize_right",
    snapContext?: { enabled: boolean; points: number[] },
  ) => {
    const { delta } = event;
    let deltaTicks = useTimelineViewStore.getState().pxToTicks(delta.x);
    const side = operation === "resize_left" ? "left" : "right";
    const minDuration = getMinimumClipDurationTicks(
      useProjectStore.getState().config.fps,
    );

    // Re-calculate constraints for final validation (safety check)
    // We access clips fresh here
    const constraints = getResizeConstraints(
      clip,
      useTimelineStore.getState().clips,
      side,
      minDuration,
    );

    // Commit-time snapping only (no live snap during drag).
    const snapEnabled = snapContext?.enabled ?? false;
    const snapPoints = snapContext?.points ?? [];
    if (snapEnabled && snapPoints.length > 0) {
      const ticksToPx = useTimelineViewStore.getState().ticksToPx;
      const rangeSnapPoints = snapPoints.filter(
        (tick) => tick >= constraints.min && tick <= constraints.max,
      );

      if (side === "left") {
        const proposedStart = clamp(
          clip.start + deltaTicks,
          constraints.min,
          constraints.max,
        );
        const candidate = getEdgeSnapCandidate(
          proposedStart,
          rangeSnapPoints,
          ticksToPx,
          SNAP_THRESHOLD_PX,
        );
        if (candidate) {
          const snappedStart = clamp(
            candidate.snapTick,
            constraints.min,
            constraints.max,
          );
          deltaTicks = snappedStart - clip.start;
        }
      } else {
        const originalEnd = clip.start + clip.timelineDuration;
        const proposedEnd = clamp(
          originalEnd + deltaTicks,
          constraints.min,
          constraints.max,
        );
        const candidate = getEdgeSnapCandidate(
          proposedEnd,
          rangeSnapPoints,
          ticksToPx,
          SNAP_THRESHOLD_PX,
        );
        if (candidate) {
          const snappedEnd = clamp(
            candidate.snapTick,
            constraints.min,
            constraints.max,
          );
          deltaTicks = snappedEnd - originalEnd;
        }
      }
    }

    const ticksPerFrame = getTicksPerFrame(
      useProjectStore.getState().config.fps,
    );

    if (side === "left") {
      let newStart = clip.start + deltaTicks;
      newStart = clamp(newStart, constraints.min, constraints.max);
      newStart = snapTickToFrame(newStart, ticksPerFrame);
      newStart = clamp(newStart, constraints.min, constraints.max);
      const validDelta = newStart - clip.start;

      const newShape = getResizedClipLeft(clip, validDelta);

      useTimelineStore.getState().updateClipShape(clip.id, {
        start: newShape.start,
        timelineDuration: newShape.timelineDuration,
        offset: newShape.offset,
        transformedOffset: newShape.transformedOffset,
        croppedSourceDuration: newShape.croppedSourceDuration,
      });
    } else {
      let newEnd = clip.start + clip.timelineDuration + deltaTicks;
      newEnd = clamp(newEnd, constraints.min, constraints.max);
      newEnd = snapTickToFrame(newEnd, ticksPerFrame);
      newEnd = clamp(newEnd, constraints.min, constraints.max);

      // Calculate the valid delta from the original end
      // validDelta = newEnd - (start + timelineDuration)
      // But getResizedClipRight takes deltaTicks.

      // Let's just calculate the delta we want to apply to the timelineDuration
      const validDelta = newEnd - clip.start - clip.timelineDuration;

      const newShape = getResizedClipRight(clip, validDelta);

      useTimelineStore.getState().updateClipShape(clip.id, {
        timelineDuration: newShape.timelineDuration,
        croppedSourceDuration: newShape.croppedSourceDuration,
      });
    }
  };

  return { handleMove, handleEnd };
};
