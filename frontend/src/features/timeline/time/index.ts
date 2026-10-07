export { getTimelineTime } from "./timelineTime";
export type { TimelineTime, TimelineTimeSnapshot, TimelineTimeQueryOptions, PresentationRange, TimelineClipPresentation } from "./timelineTime";
export { getLiveTimelineTime, setLiveTimelineTimeSource } from "./liveTimelineTime";
export * from "./authoring";
export * from "../utils/timelineTimeDomains";
export { timelinePresentationRange } from "./timelinePlacementMapper";
export type { TimelinePresentationRange, TimelinePlacementMapper, ProjectedTimelineRegion, ProjectedTimelineClipSegment, CreateTimelinePlacementMapperOptions } from "./timelinePlacementMapper";
export * from "./playheadPlacement";
// Placement engines stay inside the boundary. Their behaviour reaches callers
// as TimelineTime methods (toClipOffset, presentationIndex, resolveStoredEnd,
// collisionView, ...), so a consumer names the question it is asking rather
// than the primitive that answers it. Only the value types cross.
export type { TimelineClipPresentationLookup, ProposedClipTimingChange, TimelineClipPresentationCollision } from "./clipPresentation";

import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import { getTimelineTime, createTimelineTimeSnapshot, type TimelineTimeSnapshot } from "./timelineTime";
import { timelinePresentationRange } from "./timelinePlacementMapper";

export function createTimelinePlacementMapper(snapshot: TimelineTimeSnapshot) {
  return createTimelineTimeSnapshot(snapshot);
}
export interface CollectTimelineRegionClipsOptions extends TimelineTimeSnapshot { start: number; end?: number }
export function collectTimelineRegionClips({ start, end, ...snapshot }: CollectTimelineRegionClipsOptions) {
  return getTimelineTime(snapshot).regionTopology(timelinePresentationRange(start, end ?? start + 1));
}
export function buildTimelineClipPresentationLookup(tracks: readonly TimelineTrack[], clips: readonly TimelineClip[], fps: number) {
  return getTimelineTime({ tracks, clips, fps }).renderLookup();
}
export function computeFurthestPresentationEnd(tracks: readonly TimelineTrack[], clips: readonly TimelineClip[], fps: number, subset: readonly TimelineClip[] = clips) {
  const time = getTimelineTime({ tracks, clips, fps });
  return Math.round(subset.reduce((end, clip) => Math.max(end, time.footprint(clip.id)?.end ?? 0), 0));
}
export function resolveClipEffectiveTrackTick(tracks: readonly TimelineTrack[], clips: readonly TimelineClip[], fps: number, clip: TimelineClip, tick: number) {
  return getTimelineTime({ tracks, clips, fps }).renderLookup().resolveEffectiveTrackTickWithinClip(clip, tick);
}
export function resolveClipPresentation(tracks: readonly TimelineTrack[], clips: readonly TimelineClip[], fps: number, clip: TimelineClip) {
  return getTimelineTime({ tracks, clips, fps }).renderLookup().getPresentation(clip.id);
}
export { projectTimelineSelection, convertLegacyTimelineSelection, inferSelectionTracks, updateTimelineSelection, timelineSelectionFromRegion } from "./selection";
