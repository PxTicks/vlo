import { useProjectStore } from "../../project";
import {
  TICKS_PER_SECOND,
  getTimelineDuration,
  useTimelineStore,
} from "../../timeline";
import type {
  NonMaskTimelineClip,
  TimelineClip,
  TimelineSelection,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { useTimelineSelectionStore } from "../useTimelineSelectionStore";
import {
  getClipsInSelection,
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
  fps?: number;
  frameStep?: number;
  message?: string;
  includedTrackIds?: readonly string[];
}

export function createTimelineSelection(
  startTick: number,
  endTick: number,
): TimelineSelection {
  const clips = useTimelineStore.getState().clips;
  const tracks = useTimelineStore.getState().tracks;
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

  return {
    start: startTick,
    end: endTick,
    clips: getClipsInSelection(clips, {
      start: startTick,
      end: endTick,
      clips: [],
    }),
    tracks,
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
  const clips = useTimelineStore.getState().clips;
  const tracks = useTimelineStore.getState().tracks;
  const projectFps = Math.max(1, useProjectStore.getState().config.fps);

  return {
    start: tick,
    clips: getClipsInSelection(clips, {
      start: tick,
      clips: [],
    }),
    tracks,
    fps: projectFps,
  };
}

export function createTimelineSelectionFromClipIds({
  clipIds,
  clips,
  tracks,
  fps,
  frameStep,
  message,
  includedTrackIds,
}: CreateTimelineSelectionFromClipIdsOptions): TimelineSelection | null {
  const sourceClips = clips ?? useTimelineStore.getState().clips;
  const sourceTracks = tracks ?? useTimelineStore.getState().tracks;
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

  return {
    start,
    end,
    clips: structuredClone(selectionClips),
    tracks: sourceTracks.map((track) => structuredClone(track)),
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
