import { useProjectStore } from "../../project";
import { TICKS_PER_SECOND } from "../../../core/time/constants";
import {
  getTimelineClips,
  getTimelineDuration,
  getTimelineClipsInPresentationRange,
  getTimelineTracks,
  getTimelineTransitions,
} from "../../timeline/api";
import type {
  NonMaskTimelineClip,
  TimelineClip,
  TimelineSelection,
  TimelineTrack,
  Transition,
} from "../../../types/TimelineTypes";
import { useTimelineSelectionStore } from "../useTimelineSelectionStore";
import {
  getReferencedSubordinateClipIds,
  getTicksPerFrame,
  resolveSelectionFps,
  resolveSelectionFrameStep,
  snapFrameCountToStep,
} from "./timelineSelection";

export interface CreateTimelineSelectionFromClipIdsOptions {
  clipIds: readonly string[];
  clips?: readonly TimelineClip[];
  tracks?: readonly TimelineTrack[];
  transitions?: readonly Transition[];
  fps?: number;
  frameStep?: number;
  message?: string;
  includedTrackIds?: readonly string[];
}

export function createTimelineSelection(
  startTick: number,
  endTick: number,
): TimelineSelection {
  const tracks = getTimelineTracks();
  const transitions = getTimelineTransitions();
  const projectFps = Math.max(1, useProjectStore.getState().config.fps);
  const {
    selectionFpsOverride,
    selectionFrameStep,
    selectionMessage,
    selectionIncludeModeEnabled,
    selectionIncludedTrackIds,
  } =
    useTimelineSelectionStore.getState();
  const selectionFps = resolveSelectionFps(
    { fps: selectionFpsOverride },
    projectFps,
  );

  const selectedClips = getTimelineClipsInPresentationRange(startTick, endTick);
  const selectedClipIds = new Set(selectedClips.map((clip) => clip.id));
  const selectedTransitions = transitions.filter(
    (transition) =>
      selectedClipIds.has(transition.outgoingClipId) &&
      selectedClipIds.has(transition.incomingClipId),
  );

  return {
    start: startTick,
    end: endTick,
    clips: selectedClips,
    tracks,
    ...(selectedTransitions.length > 0
      ? { transitions: selectedTransitions }
      : {}),
    ...(selectionMessage ? { message: selectionMessage } : {}),
    ...(selectionIncludeModeEnabled && selectionIncludedTrackIds.length > 0
      ? { includedTrackIds: selectionIncludedTrackIds.slice() }
      : {}),
    fps: selectionFps,
    frameStep: selectionFrameStep,
  };
}

export function createPointTimelineSelection(
  tick: number,
): TimelineSelection {
  const tracks = getTimelineTracks();
  const transitions = getTimelineTransitions();
  const projectFps = Math.max(1, useProjectStore.getState().config.fps);

  const selectedClips = getTimelineClipsInPresentationRange(tick);
  const selectedClipIds = new Set(selectedClips.map((clip) => clip.id));
  const selectedTransitions = transitions.filter(
    (transition) =>
      selectedClipIds.has(transition.outgoingClipId) &&
      selectedClipIds.has(transition.incomingClipId),
  );
  return {
    start: tick,
    clips: selectedClips,
    tracks,
    ...(selectedTransitions.length > 0
      ? { transitions: selectedTransitions }
      : {}),
    fps: projectFps,
  };
}

export function createTimelineSelectionFromClipIds({
  clipIds,
  clips,
  tracks,
  transitions,
  fps,
  frameStep,
  message,
  includedTrackIds,
}: CreateTimelineSelectionFromClipIdsOptions): TimelineSelection | null {
  const sourceClips = clips ?? getTimelineClips();
  const sourceTracks = tracks ?? getTimelineTracks();
  const sourceTransitions = transitions ?? getTimelineTransitions();
  const selectedClipIds = new Set(clipIds);
  const primaryClips = sourceClips.filter(
    (clip): clip is NonMaskTimelineClip =>
      selectedClipIds.has(clip.id) && clip.type !== "mask",
  );

  if (primaryClips.length === 0) {
    return null;
  }

  const start = Math.min(...primaryClips.map((clip) => clip.start));
  const end = Math.max(
    ...primaryClips.map((clip) => clip.start + clip.timelineDuration),
  );
  const subordinateClipIds = new Set(
    getReferencedSubordinateClipIds(primaryClips),
  );
  const selectionClips = sourceClips.filter(
    (clip) => selectedClipIds.has(clip.id) || subordinateClipIds.has(clip.id),
  );
  const selectionTransitions = sourceTransitions.filter(
    (transition) =>
      selectedClipIds.has(transition.outgoingClipId) &&
      selectedClipIds.has(transition.incomingClipId),
  );

  return {
    start,
    end,
    clips: structuredClone(selectionClips),
    tracks: sourceTracks.map((track) => structuredClone(track)),
    ...(selectionTransitions.length > 0
      ? {
          transitions: selectionTransitions.map((transition) =>
            structuredClone(transition),
          ),
        }
      : {}),
    ...(message ? { message } : {}),
    ...(includedTrackIds && includedTrackIds.length > 0
      ? { includedTrackIds: [...includedTrackIds] }
      : {}),
    ...(typeof fps === "number" ? { fps } : {}),
    ...(typeof frameStep === "number" ? { frameStep } : {}),
  };
}

export function getDefaultSelectionEnd(startTick: number): number {
  const fps = useProjectStore.getState().config.fps;
  const { selectionFpsOverride, selectionFrameStep } =
    useTimelineSelectionStore.getState();
  const effectiveFps = resolveSelectionFps(
    { fps: selectionFpsOverride },
    fps,
  );
  const frameStep = resolveSelectionFrameStep({
    frameStep: selectionFrameStep,
  });
  const ticksPerFrame = getTicksPerFrame(effectiveFps);
  const maxDuration = getTimelineDuration();
  const oneSecondLater = startTick + TICKS_PER_SECOND;
  const requestedEndTick = Math.min(oneSecondLater, maxDuration);
  const rawFrameCount = Math.max(
    1,
    Math.ceil((requestedEndTick - startTick) / ticksPerFrame),
  );
  const safeFrameCount = snapFrameCountToStep(rawFrameCount, frameStep, "floor");
  return startTick + safeFrameCount * ticksPerFrame;
}
