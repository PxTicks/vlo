import { projectTimelineSelection } from "../../timeline/time";
import { useProjectStore } from "../../project";
import { TICKS_PER_SECOND } from "../../../core/time/constants";
import {
  getTimelineClips,
  getTimelineDuration,
  getTimelineSelectionClips,
  getTimelineTracks,
  getTimelineTransitions,
} from "../../timeline/api";
import {
  getTimelineTime,
  timelinePresentationRange,
} from "../../timeline/time";
import type {
  NonMaskTimelineClip,
  TimelineClip,
  TimelineSelection,
  TimelineTrack,
  Transition,
} from "../../../types/TimelineTypes";
import { useTimelineSelectionStore } from "../useTimelineSelectionStore";
import { resolveSelectionRenderResolution } from "./selectionRenderResolution";
import {
  getReferencedSubordinateClipIds,
  getTicksPerFrame,
  resolveSelectionFps,
  resolveSelectionFrameOffset,
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
  frameOffset?: number;
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
    selectionResolutionOverride,
    selectionRecommendedResolution,
    selectionFrameStep,
    selectionFrameOffset,
    selectionMessage,
    selectionIncludeModeEnabled,
    selectionIncludedTrackIds,
    selectionAudioOnly,
  } =
    useTimelineSelectionStore.getState();
  const selectionFps = resolveSelectionFps(
    { fps: selectionFpsOverride },
    projectFps,
  );
  // Resolved here, like fps: the region then renders the same way whatever the
  // store or the project settings do afterwards.
  const selectionResolution = resolveSelectionRenderResolution({
    override: selectionResolutionOverride,
    recommended: selectionRecommendedResolution,
    project: useProjectStore.getState().config.outputResolution,
  });

  const selectedClips = getTimelineSelectionClips(startTick, endTick);
  const selectedClipIds = new Set(selectedClips.map((clip) => clip.id));
  const selectedTransitions = transitions.filter(
    (transition) =>
      selectedClipIds.has(transition.outgoingClipId) &&
      selectedClipIds.has(transition.incomingClipId),
  );

  return projectTimelineSelection({
    start: startTick,
    end: endTick,
    clips: selectedClips,
    tracks,
    ...(selectedTransitions.length > 0
      ? { transitions: selectedTransitions }
      : {}),
    resolution: selectionResolution,
    aspectRatio: useProjectStore.getState().config.aspectRatio,
    ...(selectionMessage ? { message: selectionMessage } : {}),
    ...(selectionIncludeModeEnabled && selectionIncludedTrackIds.length > 0
      ? { includedTrackIds: selectionIncludedTrackIds.slice() }
      : {}),
    fps: selectionFps,
    frameStep: selectionFrameStep,
    frameOffset: selectionFrameOffset,
    // Resolved here like fps and resolution: what the selection was taken as
    // travels with it, so the extraction it produced stays readable from the
    // selection alone.
    ...(selectionAudioOnly ? { audioOnly: true as const } : {}),
  }, { tracks, clips: getTimelineClips(), fps: projectFps });
}

export function createPointTimelineSelection(
  tick: number,
): TimelineSelection {
  const tracks = getTimelineTracks();
  const transitions = getTimelineTransitions();
  const projectFps = Math.max(1, useProjectStore.getState().config.fps);

  const selectedClips = getTimelineSelectionClips(tick);
  const selectedClipIds = new Set(selectedClips.map((clip) => clip.id));
  const selectedTransitions = transitions.filter(
    (transition) =>
      selectedClipIds.has(transition.outgoingClipId) &&
      selectedClipIds.has(transition.incomingClipId),
  );
  return projectTimelineSelection({
    start: tick,
    aspectRatio: useProjectStore.getState().config.aspectRatio,
    clips: selectedClips,
    tracks,
    ...(selectedTransitions.length > 0
      ? { transitions: selectedTransitions }
      : {}),
    fps: projectFps,
  }, { tracks, clips: getTimelineClips(), fps: projectFps });
}

export function createTimelineSelectionFromClipIds({
  clipIds,
  clips,
  tracks,
  transitions,
  fps,
  frameStep,
  frameOffset,
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

  // The selection's bounds are presentation ticks: where the clips appear on
  // the timeline, which differs from their stored ticks under adjustment
  // retiming.
  const presentationFps = Math.max(1, useProjectStore.getState().config.fps);
  const placementMapper = getTimelineTime({
    tracks: sourceTracks,
    clips: sourceClips,
    fps: presentationFps,
  });
  const footprints = primaryClips.map(
    (clip) =>
      placementMapper.getPresentationFootprint(clip.id) ?? {
        start: clip.start,
        end: clip.start + clip.timelineDuration,
      },
  );
  const start = Math.min(...footprints.map((footprint) => footprint.start));
  const end = Math.max(...footprints.map((footprint) => footprint.end));
  const subordinateClipIds = new Set(
    getReferencedSubordinateClipIds(primaryClips),
  );
  // Retiming adjustments ahead of or over the range place its clips; the
  // selection renders detached, so it has to carry them.
  const timingContextClipIds = new Set(
    placementMapper.getTimingContextClipIds(
      timelinePresentationRange(start, end),
    ),
  );
  const selectionClips = sourceClips.filter(
    (clip) =>
      selectedClipIds.has(clip.id) ||
      subordinateClipIds.has(clip.id) ||
      timingContextClipIds.has(clip.id),
  );
  const selectionTransitions = sourceTransitions.filter(
    (transition) =>
      selectedClipIds.has(transition.outgoingClipId) &&
      selectedClipIds.has(transition.incomingClipId),
  );

  return projectTimelineSelection({
    start,
    end,
    aspectRatio: useProjectStore.getState().config.aspectRatio,
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
    ...(typeof frameOffset === "number" ? { frameOffset } : {}),
  }, { tracks: sourceTracks, clips: sourceClips, fps: presentationFps });
}

export interface DefaultSelectionEndGrid {
  fps?: number | null;
  frameStep?: number | null;
  frameOffset?: number | null;
}

/**
 * Seeds the range a selection opens with. The grid is taken from `grid` when
 * the caller already knows what the upcoming selection requires — the store
 * still holds the *previous* selection's values at this point, and reading
 * them would seed, say, a plain extraction with the last workflow's step.
 */
export function getDefaultSelectionEnd(
  startTick: number,
  grid?: DefaultSelectionEndGrid,
): number {
  const fps = useProjectStore.getState().config.fps;
  const effectiveFps = resolveSelectionFps(
    { fps: grid?.fps ?? null },
    fps,
  );
  const frameStep = resolveSelectionFrameStep({
    frameStep: grid?.frameStep ?? null,
  });
  const frameOffset = resolveSelectionFrameOffset({
    frameOffset: grid?.frameOffset ?? null,
  });
  const ticksPerFrame = getTicksPerFrame(effectiveFps);
  const maxDuration = getTimelineDuration();
  const oneSecondLater = startTick + TICKS_PER_SECOND;
  const requestedEndTick = Math.min(oneSecondLater, maxDuration);
  const rawFrameCount = Math.max(
    1,
    Math.ceil((requestedEndTick - startTick) / ticksPerFrame),
  );
  // When the timeline runs out before the grid's smallest valid count, the
  // default still spans that count and overhangs the end. The grid is a hard
  // workflow requirement, so an overhang the user can see and drag back beats
  // seeding them with a length the generation would reject.
  const safeFrameCount = snapFrameCountToStep(
    rawFrameCount,
    frameStep,
    "floor",
    frameOffset,
  );
  return startTick + safeFrameCount * ticksPerFrame;
}
