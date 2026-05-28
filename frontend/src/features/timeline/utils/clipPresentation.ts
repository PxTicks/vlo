import type {
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { buildTrackTimeResolver } from "../../renderer/utils/resolveTrackTime";

const COLLISION_EPSILON_TICKS = 0.5;

export interface TimelineClipPresentation {
  clipId: string;
  trackId: string;
  start: number;
  end: number;
  duration: number;
  mapPresentationOffsetToClipOffset: (presentationOffset: number) => number;
}

export interface TimelineClipPresentationCollision {
  trackId: string;
  leftClipId: string;
  rightClipId: string;
}

export interface ProposedClipTimingChange {
  clipId: string;
  transformations?: ClipTransform[];
  timelineDuration?: number;
  transformedDuration?: number;
  transformedOffset?: number;
  croppedSourceDuration?: number;
  offset?: number;
  start?: number;
}

function applyProposedClipTimingChange(
  clip: TimelineClip,
  change: ProposedClipTimingChange,
): TimelineClip {
  if (clip.id !== change.clipId) {
    return clip;
  }

  return {
    ...clip,
    transformations: change.transformations ?? clip.transformations,
    start: change.start !== undefined ? Math.round(change.start) : clip.start,
    timelineDuration:
      change.timelineDuration !== undefined
        ? Math.round(change.timelineDuration)
        : clip.timelineDuration,
    transformedDuration:
      change.transformedDuration !== undefined
        ? Math.round(change.transformedDuration)
        : clip.transformedDuration,
    transformedOffset:
      change.transformedOffset !== undefined
        ? Math.round(change.transformedOffset)
        : clip.transformedOffset,
    croppedSourceDuration:
      change.croppedSourceDuration !== undefined
        ? Math.round(change.croppedSourceDuration)
        : clip.croppedSourceDuration,
    offset: change.offset !== undefined ? Math.round(change.offset) : clip.offset,
  };
}

export function buildTimelineClipPresentationIndex(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
): Map<string, TimelineClipPresentation> {
  const resolver = buildTrackTimeResolver(tracks, clips);
  const presentationByClipId = new Map<string, TimelineClipPresentation>();

  for (const clip of clips) {
    if (clip.type === "mask") {
      continue;
    }

    const start = resolver.resolvePresentationTick(clip.trackId, clip.start);
    const end = resolver.resolvePresentationTick(
      clip.trackId,
      clip.start + clip.timelineDuration,
    );
    const duration = Math.max(0, end - start);

    presentationByClipId.set(clip.id, {
      clipId: clip.id,
      trackId: clip.trackId,
      start,
      end,
      duration,
      mapPresentationOffsetToClipOffset(presentationOffset) {
        return (
          resolver.resolveEffectiveTrackTick(
            clip.trackId,
            start + presentationOffset,
          ) - clip.start
        );
      },
    });
  }

  return presentationByClipId;
}

export function resolveStoredTrackTickForPresentation(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  trackId: string,
  presentationTick: number,
): number {
  return buildTrackTimeResolver(tracks, clips).resolveEffectiveTrackTick(
    trackId,
    presentationTick,
  );
}

function collectPresentationCollisionsFromIndex(
  presentationByClipId: Map<string, TimelineClipPresentation>,
): TimelineClipPresentationCollision[] {
  const placementsByTrack = new Map<string, TimelineClipPresentation[]>();

  for (const placement of presentationByClipId.values()) {
    const trackPlacements = placementsByTrack.get(placement.trackId) ?? [];
    trackPlacements.push(placement);
    placementsByTrack.set(placement.trackId, trackPlacements);
  }

  const collisions: TimelineClipPresentationCollision[] = [];
  for (const [trackId, placements] of placementsByTrack) {
    placements.sort((left, right) => {
      const startDelta = left.start - right.start;
      return Math.abs(startDelta) > COLLISION_EPSILON_TICKS
        ? startDelta
        : left.end - right.end;
    });

    for (let index = 1; index < placements.length; index += 1) {
      const previous = placements[index - 1];
      const current = placements[index];
      if (previous.end > current.start + COLLISION_EPSILON_TICKS) {
        collisions.push({
          trackId,
          leftClipId: previous.clipId,
          rightClipId: current.clipId,
        });
      }
    }
  }

  return collisions;
}

function collisionKey(collision: TimelineClipPresentationCollision): string {
  return `${collision.trackId}:${collision.leftClipId}:${collision.rightClipId}`;
}

export function collectTimelineClipPresentationCollisions(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
): TimelineClipPresentationCollision[] {
  return collectPresentationCollisionsFromIndex(
    buildTimelineClipPresentationIndex(tracks, clips),
  );
}

export function introducesTimelineClipPresentationCollision(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  change: ProposedClipTimingChange,
): boolean {
  const beforeCollisions = new Set(
    collectTimelineClipPresentationCollisions(tracks, clips).map(collisionKey),
  );
  const nextClips = clips.map((clip) =>
    applyProposedClipTimingChange(clip, change),
  );

  return collectTimelineClipPresentationCollisions(tracks, nextClips).some(
    (collision) => !beforeCollisions.has(collisionKey(collision)),
  );
}
