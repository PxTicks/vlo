import type { DragEndEvent, DragMoveEvent } from "@dnd-kit/core";
import { useTimelineStore } from "../../useTimelineStore";
import { useTimelineViewStore } from "../useTimelineViewStore";
import {
  getMinimumClipDurationTicks,
  getResizeConstraints,
  hasAnyCollision,
} from "../../utils/collision";
import { SNAP_THRESHOLD_PX } from "../../constants";
import { getResizedClipLeft, getResizedClipRight } from "../../utils/clipMath";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import { useInteractionStore } from "../useInteractionStore";
import { getEdgeSnapCandidate } from "./snapUtils";
import { useProjectStore } from "../../../project";
import { getTicksPerFrame, snapTickToFrame } from "../../../timelineSelection";
import {
  buildTimelineClipPresentationCollisionView,
  buildTimelineClipPresentationIndex,
  resolveStoredEndForPresentationEnd,
  resolveStoredStartForPresentationStart,
} from "../../utils/clipPresentation";

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
    const timelineState = useTimelineStore.getState();
    const clips = timelineState.clips ?? [];
    const tracks = timelineState.tracks ?? [];
    const presentation = buildTimelineClipPresentationIndex(
      tracks,
      clips,
      useProjectStore.getState().config.fps,
    ).get(clip.id);

    const hysteresisPx = SNAP_THRESHOLD_PX + 3;

    if (side === "left") {
      // 1. Calculate the raw unclamped position based on cursor
      const rawProposedStart = (presentation?.start ?? clip.start) + deltaTicks;

      // 2. Find the best snap candidate for that raw position among *all* points
      const candidate = getEdgeSnapCandidate(
        rawProposedStart,
        interaction.snapPoints,
        ticksToPx,
        SNAP_THRESHOLD_PX,
      );

      // 3. Verify the candidate doesn't violate hard constraints
      // Also apply hysteresis if we were already snapping
      const candidateStoredStart =
        candidate === null
          ? null
          : resolveStoredStartForPresentationStart(
              tracks,
              clips,
              clip.trackId,
              candidate.snapTick,
            );

      if (
        candidate === null ||
        candidateStoredStart === null ||
        candidateStoredStart < constraints.min ||
        candidateStoredStart > constraints.max
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
    const originalEnd = presentation?.end ?? clip.start + clip.timelineDuration;
    const rawProposedEnd = originalEnd + deltaTicks;

    const candidate = getEdgeSnapCandidate(
      rawProposedEnd,
      interaction.snapPoints,
      ticksToPx,
      SNAP_THRESHOLD_PX,
    );
    const candidateStoredEnd =
      candidate === null
        ? null
        : resolveStoredEndForPresentationEnd(
            tracks,
            clips,
            clip,
            candidate.snapTick,
          );

    if (
      candidate === null ||
      candidateStoredEnd === null ||
      candidateStoredEnd < constraints.min ||
      candidateStoredEnd > constraints.max
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
    const ticksPerFrame = getTicksPerFrame(
      useProjectStore.getState().config.fps,
    );
    const timelineState = useTimelineStore.getState();
    const clips = timelineState.clips ?? [];
    const tracks = timelineState.tracks ?? [];
    const presentation = buildTimelineClipPresentationIndex(
      tracks,
      clips,
      useProjectStore.getState().config.fps,
    ).get(clip.id);
    const currentPresentationStart = presentation?.start ?? clip.start;
    const currentPresentationEnd =
      presentation?.end ?? clip.start + clip.timelineDuration;

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
      const rangeSnapPoints = snapPoints.filter((tick) => {
        const storedTick =
          side === "left"
            ? resolveStoredStartForPresentationStart(
                tracks,
                clips,
                clip.trackId,
                tick,
              )
            : resolveStoredEndForPresentationEnd(tracks, clips, clip, tick);
        return storedTick >= constraints.min && storedTick <= constraints.max;
      });

      if (side === "left") {
        const proposedStart = currentPresentationStart + deltaTicks;
        const candidate = getEdgeSnapCandidate(
          proposedStart,
          rangeSnapPoints,
          ticksToPx,
          SNAP_THRESHOLD_PX,
        );
        if (candidate) {
          const candidateStoredStart = resolveStoredStartForPresentationStart(
            tracks,
            clips,
            clip.trackId,
            candidate.snapTick,
          );
          if (
            candidateStoredStart >= constraints.min &&
            candidateStoredStart <= constraints.max
          ) {
            deltaTicks = candidate.snapTick - currentPresentationStart;
          }
        }
      } else {
        const originalEnd = currentPresentationEnd;
        const proposedEnd = originalEnd + deltaTicks;
        const candidate = getEdgeSnapCandidate(
          proposedEnd,
          rangeSnapPoints,
          ticksToPx,
          SNAP_THRESHOLD_PX,
        );
        if (candidate) {
          const candidateStoredEnd = resolveStoredEndForPresentationEnd(
            tracks,
            clips,
            clip,
            candidate.snapTick,
          );
          if (
            candidateStoredEnd >= constraints.min &&
            candidateStoredEnd <= constraints.max
          ) {
            deltaTicks = candidate.snapTick - originalEnd;
          }
        }
      }
    }

    if (side === "left") {
      const targetPresentationStart = currentPresentationStart + deltaTicks;
      let newStart = resolveStoredStartForPresentationStart(
        tracks,
        clips,
        clip.trackId,
        targetPresentationStart,
      );
      newStart = clamp(newStart, constraints.min, constraints.max);
      newStart = snapTickToFrame(newStart, ticksPerFrame);
      newStart = clamp(newStart, constraints.min, constraints.max);
      const validDelta = newStart - clip.start;

      const newShape = getResizedClipLeft(clip, validDelta);
      const collisionClips = buildTimelineClipPresentationCollisionView(
        tracks,
        clips,
        useProjectStore.getState().config.fps,
        {
          clipId: clip.id,
          start: newShape.start,
          timelineDuration: newShape.timelineDuration,
          offset: newShape.offset,
          transformedOffset: newShape.transformedOffset,
          croppedSourceDuration: newShape.croppedSourceDuration,
        },
      );
      const collisionClip = collisionClips.find(
        (candidate) => candidate.id === clip.id,
      );
      if (
        !collisionClip ||
        hasAnyCollision(
          collisionClip.start,
          collisionClip.timelineDuration,
          collisionClip.trackId,
          [clip.id],
          collisionClips,
        )
      ) {
        return;
      }

      useTimelineStore.getState().updateClipShape(clip.id, {
        start: newShape.start,
        timelineDuration: newShape.timelineDuration,
        offset: newShape.offset,
        transformedOffset: newShape.transformedOffset,
        croppedSourceDuration: newShape.croppedSourceDuration,
      });
    } else {
      // The right edge is dragged in presentation space. Outside any
      // adjustment this is identity (stored end shifts by deltaTicks). Inside
      // a speed-up region, a small presentation delta maps to a larger
      // stored-tick delta: `resolveStoredEndForPresentationEnd` goes through
      // the shared presentation model and is exact for spline-shaped speed
      // transforms.
      const targetPresentationEnd = currentPresentationEnd + deltaTicks;
      let newEnd = resolveStoredEndForPresentationEnd(
        tracks,
        clips,
        clip,
        targetPresentationEnd,
      );
      newEnd = clamp(newEnd, constraints.min, constraints.max);
      newEnd = snapTickToFrame(newEnd, ticksPerFrame);
      newEnd = clamp(newEnd, constraints.min, constraints.max);

      const validDelta = newEnd - clip.start - clip.timelineDuration;

      const newShape = getResizedClipRight(clip, validDelta);
      const collisionClips = buildTimelineClipPresentationCollisionView(
        tracks,
        clips,
        useProjectStore.getState().config.fps,
        {
          clipId: clip.id,
          timelineDuration: newShape.timelineDuration,
          croppedSourceDuration: newShape.croppedSourceDuration,
        },
      );
      const collisionClip = collisionClips.find(
        (candidate) => candidate.id === clip.id,
      );
      if (
        !collisionClip ||
        hasAnyCollision(
          collisionClip.start,
          collisionClip.timelineDuration,
          collisionClip.trackId,
          [clip.id],
          collisionClips,
        )
      ) {
        return;
      }

      useTimelineStore.getState().updateClipShape(clip.id, {
        timelineDuration: newShape.timelineDuration,
        croppedSourceDuration: newShape.croppedSourceDuration,
      });
    }
  };

  return { handleMove, handleEnd };
};
