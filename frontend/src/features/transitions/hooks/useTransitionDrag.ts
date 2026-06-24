import { useCallback } from "react";
import type {
  DragCancelEvent,
  DragEndEvent,
  DragMoveEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import type {
  TimelineClip,
  TimelineTrack,
  TransitionType,
} from "../../../types/TimelineTypes";
import {
  addTimelineTransition,
  getTimelineModelState,
  resolveCollision,
  selectTimelineTransition,
} from "../../timeline";
import {
  RULER_HEIGHT,
  TRACK_HEADER_WIDTH,
  TRACK_HEIGHT,
} from "../../timeline/constants";
import { useInteractionStore } from "../../timeline/hooks/useInteractionStore";
import { usePointerTracker } from "../../timeline/hooks/dnd/usePointerTracker";
import { useTimelineViewStore } from "../../timeline/hooks/useTimelineViewStore";
import { buildTimelineClipPresentationIndex } from "../../timeline/utils/clipPresentation";
import { resolveTransition } from "../../timeline/model/transitionModel";
import { useProjectStore } from "../../project";
import { ticksPerFrame } from "../../../core/time/frameGrid";
import { createTransition } from "../catalogue/TransitionRegistry";
import type { TransitionDragData } from "../components/TransitionCard";

interface TransitionDrop {
  outgoingClip: TimelineClip;
  incomingClip: TimelineClip;
  incomingStart?: number;
  startTick: number;
  endTick: number;
  topTrackIndex: number;
}

function isTransitionDragData(data: unknown): data is TransitionDragData {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as { type?: unknown }).type === "transition"
  );
}

function pickOutgoingAndIncoming(
  left: TimelineClip,
  right: TimelineClip,
  presentationById: ReturnType<typeof buildTimelineClipPresentationIndex>,
): { outgoingClip: TimelineClip; incomingClip: TimelineClip } {
  const leftPresentation = presentationById.get(left.id);
  const rightPresentation = presentationById.get(right.id);
  const leftStart = leftPresentation?.start ?? left.start;
  const rightStart = rightPresentation?.start ?? right.start;
  if (leftStart !== rightStart) {
    return leftStart < rightStart
      ? { outgoingClip: left, incomingClip: right }
      : { outgoingClip: right, incomingClip: left };
  }
  const leftEnd =
    leftPresentation?.end ?? left.start + left.timelineDuration;
  const rightEnd =
    rightPresentation?.end ?? right.start + right.timelineDuration;
  return leftEnd <= rightEnd
    ? { outgoingClip: left, incomingClip: right }
    : { outgoingClip: right, incomingClip: left };
}

function findActiveClip(
  trackId: string,
  clips: readonly TimelineClip[],
  presentationById: ReturnType<typeof buildTimelineClipPresentationIndex>,
  tick: number,
): TimelineClip | undefined {
  return clips.find((clip) => {
    if (clip.type === "mask" || clip.trackId !== trackId) return false;
    const presentation = presentationById.get(clip.id);
    return !!presentation && presentation.start <= tick && tick < presentation.end;
  });
}

function resolveDropForPair(options: {
  tracks: readonly TimelineTrack[];
  clips: readonly TimelineClip[];
  transitions: ReturnType<typeof getTimelineModelState>["transitions"];
  upperIndex: number;
  lowerIndex: number;
  tick: number;
  fps: number;
}): TransitionDrop | null {
  const { tracks, clips, upperIndex, lowerIndex, tick, fps } = options;
  const upper = tracks[upperIndex];
  const lower = tracks[lowerIndex];
  if (upper?.type !== "visual" || lower?.type !== "visual") return null;

  const presentationById = buildTimelineClipPresentationIndex(
    [...tracks],
    [...clips],
    fps,
  );
  const upperActive = findActiveClip(
    upper.id,
    clips,
    presentationById,
    tick,
  );
  const lowerActive = findActiveClip(
    lower.id,
    clips,
    presentationById,
    tick,
  );

  if (upperActive && lowerActive) {
    const pair = pickOutgoingAndIncoming(
      upperActive,
      lowerActive,
      presentationById,
    );
    if (
      options.transitions.some(
        (transition) =>
          transition.outgoingClipId === pair.outgoingClip.id ||
          transition.incomingClipId === pair.outgoingClip.id ||
          transition.outgoingClipId === pair.incomingClip.id ||
          transition.incomingClipId === pair.incomingClip.id,
      )
    ) {
      return null;
    }
    const outgoing = presentationById.get(pair.outgoingClip.id)!;
    const incoming = presentationById.get(pair.incomingClip.id)!;
    return {
      ...pair,
      startTick: Math.max(outgoing.start, incoming.start),
      endTick: Math.min(outgoing.end, incoming.end),
      topTrackIndex: upperIndex,
    };
  }

  const tolerance = ticksPerFrame(fps);
  const upperClips = clips.filter(
    (clip) => clip.type !== "mask" && clip.trackId === upper.id,
  );
  const lowerClips = clips.filter(
    (clip) => clip.type !== "mask" && clip.trackId === lower.id,
  );
  for (const outgoingClip of [...upperClips, ...lowerClips]) {
    const outgoingPresentation = presentationById.get(outgoingClip.id);
    if (!outgoingPresentation || Math.abs(outgoingPresentation.end - tick) > tolerance) {
      continue;
    }
    const otherClips =
      outgoingClip.trackId === upper.id ? lowerClips : upperClips;
    const incomingClip = otherClips.find((clip) => {
      const presentation = presentationById.get(clip.id);
      return presentation && Math.abs(presentation.start - tick) <= tolerance;
    });
    if (!incomingClip) continue;
    if (
      options.transitions.some(
        (transition) =>
          transition.outgoingClipId === outgoingClip.id ||
          transition.incomingClipId === outgoingClip.id ||
          transition.outgoingClipId === incomingClip.id ||
          transition.incomingClipId === incomingClip.id,
      )
    ) {
      return null;
    }

    const defaultDuration =
      ticksPerFrame(fps) * Math.max(1, Math.round(fps / 2));
    const desiredStart = Math.max(0, incomingClip.start - defaultDuration);
    const incomingStart = resolveCollision(
      incomingClip.id,
      desiredStart,
      incomingClip.timelineDuration,
      incomingClip.trackId,
      [...clips],
    );
    if (incomingStart === null || incomingStart >= incomingClip.start) {
      return null;
    }

    const movedClips = clips.map((clip) =>
      clip.id === incomingClip.id ? { ...clip, start: incomingStart } : clip,
    );
    const candidate = createTransition(
      "dissolve",
      outgoingClip.id,
      incomingClip.id,
    );
    const resolved = resolveTransition(
      candidate,
      tracks,
      movedClips,
      fps,
    );
    if (!resolved) return null;
    return {
      outgoingClip,
      incomingClip,
      incomingStart,
      startTick: resolved.start,
      endTick: resolved.end,
      topTrackIndex: upperIndex,
    };
  }

  return null;
}

export function useTransitionDrag(
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
) {
  const cursorRef = usePointerTracker();

  const computeDrop = useCallback(
    (_transitionType: TransitionType): TransitionDrop | null => {
      const container = scrollContainerRef.current;
      const cursor = cursorRef.current;
      if (!container || !cursor) return null;
      const rect = container.getBoundingClientRect();
      if (
        cursor.x < rect.left + TRACK_HEADER_WIDTH ||
        cursor.x > rect.right ||
        cursor.y < rect.top + RULER_HEIGHT ||
        cursor.y > rect.bottom
      ) {
        return null;
      }

      const model = getTimelineModelState();
      const fps = useProjectStore.getState().config.fps;
      const view = useTimelineViewStore.getState();
      const timelineX =
        cursor.x - rect.left + container.scrollLeft - TRACK_HEADER_WIDTH;
      const tick = Math.max(0, view.pxToTicks(timelineX));
      const bodyY =
        cursor.y - rect.top + container.scrollTop - RULER_HEIGHT;
      const trackIndex = Math.floor(bodyY / TRACK_HEIGHT);
      if (trackIndex < 0 || trackIndex >= model.tracks.length) return null;
      const rowOffset = bodyY - trackIndex * TRACK_HEIGHT;
      const pairStarts =
        rowOffset < TRACK_HEIGHT / 2
          ? [trackIndex - 1, trackIndex]
          : [trackIndex, trackIndex - 1];

      for (const upperIndex of pairStarts) {
        if (upperIndex < 0 || upperIndex + 1 >= model.tracks.length) continue;
        const drop = resolveDropForPair({
          ...model,
          upperIndex,
          lowerIndex: upperIndex + 1,
          tick,
          fps,
        });
        if (drop) return drop;
      }
      return null;
    },
    [cursorRef, scrollContainerRef],
  );

  const clearPreview = useCallback(() => {
    useInteractionStore.getState().clearTransitionDropPreview();
  }, []);

  const handleTransitionDragStart = useCallback((_event: DragStartEvent) => {
    clearPreview();
  }, [clearPreview]);

  const handleTransitionDragMove = useCallback(
    (event: DragMoveEvent) => {
      const data = event.active.data.current;
      if (!isTransitionDragData(data)) return;
      const drop = computeDrop(data.transitionType);
      useInteractionStore.getState().setTransitionDropPreview(
        drop
          ? {
              startTick: drop.startTick,
              endTick: drop.endTick,
              topTrackIndex: drop.topTrackIndex,
              compatible: true,
            }
          : null,
      );
    },
    [computeDrop],
  );

  const handleTransitionDragEnd = useCallback(
    (event: DragEndEvent) => {
      const data = event.active.data.current;
      const drop = isTransitionDragData(data)
        ? computeDrop(data.transitionType)
        : null;
      clearPreview();
      if (!isTransitionDragData(data) || !drop) return;

      const transition = createTransition(
        data.transitionType,
        drop.outgoingClip.id,
        drop.incomingClip.id,
      );
      if (
        addTimelineTransition(transition, {
          incomingStart: drop.incomingStart,
        })
      ) {
        selectTimelineTransition(transition.id);
      }
    },
    [clearPreview, computeDrop],
  );

  const handleTransitionDragCancel = useCallback(
    (_event: DragCancelEvent) => clearPreview(),
    [clearPreview],
  );

  return {
    handleTransitionDragStart,
    handleTransitionDragMove,
    handleTransitionDragEnd,
    handleTransitionDragCancel,
  };
}
