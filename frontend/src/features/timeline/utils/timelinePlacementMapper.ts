import type {
  MaskTimelineClip,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import {
  buildTimelineClipPresentationIndex,
  resolveStoredStartForPresentationStart,
  type TimelineClipPresentation,
} from "./clipPresentation";
import { getResizedClipLeft, getResizedClipRight } from "./clipMath";

export interface TimelinePresentationRange {
  start: number;
  end: number;
}

export interface ProjectedTimelineClipSegment {
  clipId: string;
  presentationStart: number;
  presentationEnd: number;
  storedStart: number;
  storedEnd: number;
  storedStartOffset: number;
  storedEndOffset: number;
  localPresentationStart: number;
}

export interface ProjectedTimelineRegion {
  range: TimelinePresentationRange;
  clips: TimelineClip[];
  segmentsByClipId: ReadonlyMap<string, ProjectedTimelineClipSegment>;
}

export interface TimelinePlacementMapper {
  getPresentationFootprint(
    clipId: string,
  ): TimelinePresentationRange | null;
  mapPresentationTickToStoredTick(
    clipId: string,
    presentationTick: number,
  ): number | null;
  mapStoredTickToPresentationTick(
    clipId: string,
    storedTick: number,
  ): number | null;
  resolveStoredStart(trackId: string, presentationStart: number): number;
  intersectClipWithPresentationRange(
    clipId: string,
    range: TimelinePresentationRange,
  ): ProjectedTimelineClipSegment | null;
  getClipIdsAtPresentationTick(presentationTick: number): string[];
  getClipIdsInPresentationRange(range: TimelinePresentationRange): string[];
  projectRegionToLocalTimeline(
    range: TimelinePresentationRange,
    clipIds: readonly string[],
  ): ProjectedTimelineRegion;
}

export interface CreateTimelinePlacementMapperOptions {
  tracks: readonly TimelineTrack[];
  clips: readonly TimelineClip[];
  fps: number;
}

function cropClipToStoredOffsets(
  clip: TimelineClip,
  startOffset: number,
  endOffset: number,
): TimelineClip | null {
  const boundedStart = Math.max(0, Math.min(clip.timelineDuration, startOffset));
  const boundedEnd = Math.max(0, Math.min(clip.timelineDuration, endOffset));
  if (boundedStart >= boundedEnd) return null;

  const cropped = structuredClone(clip);
  if (boundedStart > 0) {
    Object.assign(cropped, getResizedClipLeft(cropped, boundedStart));
  }

  const targetDuration = boundedEnd - boundedStart;
  if (targetDuration < cropped.timelineDuration) {
    Object.assign(
      cropped,
      getResizedClipRight(
        cropped,
        targetDuration - cropped.timelineDuration,
      ),
    );
  }

  if (cropped.type === "adjustment") {
    cropped.sourceDuration = cropped.croppedSourceDuration;
  }
  return cropped;
}

function resolveMaskParentId(clip: TimelineClip): string | null {
  if (clip.type !== "mask") return null;
  return (clip as MaskTimelineClip).parentClipId ?? null;
}

/**
 * Pins all stored/presentation mappings to one immutable timeline snapshot.
 * Callers can safely perform a multi-step mutation from its projections
 * without later steps observing partially edited adjustment topology.
 */
export function createTimelinePlacementMapper({
  tracks,
  clips,
  fps,
}: CreateTimelinePlacementMapperOptions): TimelinePlacementMapper {
  const snapshotTracks = structuredClone(tracks) as TimelineTrack[];
  const snapshotClips = structuredClone(clips) as TimelineClip[];
  const clipsById = new Map(
    snapshotClips.map((clip) => [clip.id, clip] as const),
  );
  const presentationById = buildTimelineClipPresentationIndex(
    snapshotTracks,
    snapshotClips,
    fps,
  );

  const resolvePresentation = (
    clip: TimelineClip,
  ): TimelineClipPresentation | undefined => {
    if (clip.type !== "mask") return presentationById.get(clip.id);
    const parentId = resolveMaskParentId(clip);
    return parentId ? presentationById.get(parentId) : undefined;
  };

  const getPresentationFootprint = (
    clipId: string,
  ): TimelinePresentationRange | null => {
    const clip = clipsById.get(clipId);
    if (!clip) return null;
    const presentation = resolvePresentation(clip);
    return presentation
      ? { start: presentation.start, end: presentation.end }
      : { start: clip.start, end: clip.start + clip.timelineDuration };
  };

  const mapPresentationTickToStoredTick = (
    clipId: string,
    presentationTick: number,
  ): number | null => {
    const clip = clipsById.get(clipId);
    if (!clip) return null;
    const presentation = resolvePresentation(clip);
    if (!presentation) {
      return clip.start + (presentationTick - clip.start);
    }
    return (
      clip.start +
      presentation.mapPresentationOffsetToClipOffset(
        presentationTick - presentation.start,
      )
    );
  };

  const mapStoredTickToPresentationTick = (
    clipId: string,
    storedTick: number,
  ): number | null => {
    const clip = clipsById.get(clipId);
    if (!clip) return null;
    const presentation = resolvePresentation(clip);
    if (!presentation) return storedTick;
    return (
      presentation.start +
      presentation.mapClipOffsetToPresentationOffset(storedTick - clip.start)
    );
  };

  const intersectClipWithPresentationRange = (
    clipId: string,
    range: TimelinePresentationRange,
  ): ProjectedTimelineClipSegment | null => {
    const clip = clipsById.get(clipId);
    const footprint = getPresentationFootprint(clipId);
    if (!clip || !footprint || range.end <= range.start) return null;

    const presentationStart = Math.max(footprint.start, range.start);
    const presentationEnd = Math.min(footprint.end, range.end);
    if (presentationStart >= presentationEnd) return null;

    const mappedStart = mapPresentationTickToStoredTick(
      clipId,
      presentationStart,
    );
    const mappedEnd = mapPresentationTickToStoredTick(
      clipId,
      presentationEnd,
    );
    if (mappedStart === null || mappedEnd === null) return null;

    const storedStart = Math.max(
      clip.start,
      Math.min(clip.start + clip.timelineDuration, Math.round(mappedStart)),
    );
    const storedEnd = Math.max(
      clip.start,
      Math.min(clip.start + clip.timelineDuration, Math.round(mappedEnd)),
    );
    if (storedStart >= storedEnd) return null;

    return {
      clipId,
      presentationStart,
      presentationEnd,
      storedStart,
      storedEnd,
      storedStartOffset: storedStart - clip.start,
      storedEndOffset: storedEnd - clip.start,
      localPresentationStart: presentationStart - range.start,
    };
  };

  const getClipIdsInPresentationRange = (
    range: TimelinePresentationRange,
  ): string[] => {
    const selectedParentIds = new Set(
      snapshotClips
        .filter(
          (clip) =>
            clip.type !== "mask" &&
            intersectClipWithPresentationRange(clip.id, range) !== null,
        )
        .map((clip) => clip.id),
    );
    return snapshotClips
      .filter((clip) => {
        if (selectedParentIds.has(clip.id)) return true;
        const parentId = resolveMaskParentId(clip);
        return parentId !== null && selectedParentIds.has(parentId);
      })
      .map((clip) => clip.id);
  };

  const getClipIdsAtPresentationTick = (presentationTick: number): string[] => {
    const selectedParentIds = new Set(
      snapshotClips
        .filter((clip) => {
          if (clip.type === "mask") return false;
          const footprint = getPresentationFootprint(clip.id);
          return (
            footprint !== null &&
            footprint.start <= presentationTick &&
            presentationTick < footprint.end
          );
        })
        .map((clip) => clip.id),
    );
    return snapshotClips
      .filter((clip) => {
        if (selectedParentIds.has(clip.id)) return true;
        const parentId = resolveMaskParentId(clip);
        return parentId !== null && selectedParentIds.has(parentId);
      })
      .map((clip) => clip.id);
  };

  const projectRegionToLocalTimeline = (
    range: TimelinePresentationRange,
    clipIds: readonly string[],
  ): ProjectedTimelineRegion => {
    const selectedIds = new Set(clipIds);
    const segmentsByClipId = new Map<string, ProjectedTimelineClipSegment>();
    const projectedClips = snapshotClips.flatMap((clip) => {
      if (!selectedIds.has(clip.id)) return [];
      const segment = intersectClipWithPresentationRange(clip.id, range);
      if (!segment) return [];
      const projected = cropClipToStoredOffsets(
        clip,
        segment.storedStartOffset,
        segment.storedEndOffset,
      );
      if (!projected) return [];
      segmentsByClipId.set(clip.id, segment);
      return [projected];
    });

    const trackPositionById = new Map(
      snapshotTracks.map((track, index) => [track.id, index] as const),
    );
    const adjustments = projectedClips
      .filter((clip) => clip.type === "adjustment")
      .sort(
        (left, right) =>
          (trackPositionById.get(left.trackId) ?? Number.MAX_SAFE_INTEGER) -
          (trackPositionById.get(right.trackId) ?? Number.MAX_SAFE_INTEGER),
      );
    const positionClip = (clip: TimelineClip): void => {
      const segment = segmentsByClipId.get(clip.id);
      if (!segment) return;
      clip.start = resolveStoredStartForPresentationStart(
        snapshotTracks,
        projectedClips,
        clip.trackId,
        segment.localPresentationStart,
      );
    };
    adjustments.forEach(positionClip);
    projectedClips
      .filter((clip) => clip.type !== "adjustment" && clip.type !== "mask")
      .forEach(positionClip);

    const projectedById = new Map(
      projectedClips.map((clip) => [clip.id, clip] as const),
    );
    projectedClips.forEach((clip) => {
      const parentId = resolveMaskParentId(clip);
      if (!parentId) return;
      const parent = projectedById.get(parentId);
      if (parent) clip.start = parent.start;
    });

    return {
      range: { ...range },
      clips: projectedClips,
      segmentsByClipId,
    };
  };

  return {
    getPresentationFootprint,
    mapPresentationTickToStoredTick,
    mapStoredTickToPresentationTick,
    resolveStoredStart(trackId, presentationStart) {
      return resolveStoredStartForPresentationStart(
        snapshotTracks,
        snapshotClips,
        trackId,
        presentationStart,
      );
    },
    intersectClipWithPresentationRange,
    getClipIdsAtPresentationTick,
    getClipIdsInPresentationRange,
    projectRegionToLocalTimeline,
  };
}
