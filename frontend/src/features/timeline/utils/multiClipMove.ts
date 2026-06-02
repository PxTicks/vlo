import type {
  StandardTimelineClip,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { isNonMaskTimelineClip } from "../../../types/TimelineTypes";
import { snapTickToFrame } from "../../timelineSelection";
import { hasAnyCollision } from "./collision";
import { buildTimelineClipPresentationCollisionView } from "./clipPresentation";
import { getTrackTypeFromClipType } from "./formatting";

export interface PlannedTimelineClipMove {
  clipId: string;
  start: number;
  trackId: string;
}

export interface PlanMultiClipMoveOptions {
  clips: TimelineClip[];
  selectedClipIds: string[];
  tracks: TimelineTrack[];
  leaderClip: StandardTimelineClip;
  targetStartTicks: number;
  targetTrackId?: string;
  ticksPerFrame: number;
  /** Project (output) fps — quantizes the presentation collision grid. */
  fps: number;
  insertedTrack?: TimelineTrack;
  insertTrackIndex?: number | null;
}

export function planMultiClipMove(
  options: PlanMultiClipMoveOptions,
): PlannedTimelineClipMove[] | null {
  const {
    clips,
    selectedClipIds,
    tracks,
    leaderClip,
    targetStartTicks,
    targetTrackId,
    ticksPerFrame,
    fps,
    insertedTrack,
    insertTrackIndex,
  } = options;

  if (selectedClipIds.length <= 1) {
    return null;
  }

  const virtualTracks = [...tracks];
  const resolvedTargetTrackId =
    insertedTrack && insertTrackIndex != null
      ? (() => {
          const safeInsertIndex = Math.max(
            0,
            Math.min(insertTrackIndex, virtualTracks.length),
          );
          virtualTracks.splice(safeInsertIndex, 0, insertedTrack);
          return insertedTrack.id;
        })()
      : targetTrackId;

  if (!resolvedTargetTrackId) {
    return null;
  }

  const leaderOriginalTrackIndex = virtualTracks.findIndex(
    (track) => track.id === leaderClip.trackId,
  );
  const targetTrackIndex = virtualTracks.findIndex(
    (track) => track.id === resolvedTargetTrackId,
  );

  if (leaderOriginalTrackIndex === -1 || targetTrackIndex === -1) {
    return null;
  }

  const selectedSet = new Set(selectedClipIds);
  if (!selectedSet.has(leaderClip.id)) {
    return null;
  }

  const selectedClips = clips.filter(
    (clip): clip is StandardTimelineClip =>
      selectedSet.has(clip.id) && isNonMaskTimelineClip(clip),
  );
  if (selectedClips.length <= 1) {
    return null;
  }

  const trackDelta = targetTrackIndex - leaderOriginalTrackIndex;
  const deltaTicks = targetStartTicks - leaderClip.start;

  const plannedMoves: PlannedTimelineClipMove[] = [];

  for (const clip of selectedClips) {
    const currentTrackIndex = virtualTracks.findIndex(
      (track) => track.id === clip.trackId,
    );
    if (currentTrackIndex === -1) {
      return null;
    }

    const newTrackIndex = currentTrackIndex + trackDelta;
    if (newTrackIndex < 0 || newTrackIndex >= virtualTracks.length) {
      return null;
    }

    const destinationTrack = virtualTracks[newTrackIndex];
    if (
      destinationTrack.type &&
      destinationTrack.type !== getTrackTypeFromClipType(clip.type)
    ) {
      return null;
    }

    const newStart = snapTickToFrame(
      Math.max(0, clip.start + deltaTicks),
      ticksPerFrame,
    );

    plannedMoves.push({
      clipId: clip.id,
      start: newStart,
      trackId: destinationTrack.id,
    });
  }

  const plannedMoveById = new Map(
    plannedMoves.map((move) => [move.clipId, move]),
  );
  const nextClips = clips.map((clip) => {
    const move = plannedMoveById.get(clip.id);
    return move
      ? {
          ...clip,
          start: move.start,
          trackId: move.trackId,
        }
      : clip;
  });
  const collisionClips = buildTimelineClipPresentationCollisionView(
    virtualTracks,
    nextClips,
    fps,
  );

  for (const move of plannedMoves) {
    const collisionClip = collisionClips.find(
      (clip) => clip.id === move.clipId,
    );
    if (!collisionClip) {
      return null;
    }

    if (
      hasAnyCollision(
        collisionClip.start,
        collisionClip.timelineDuration,
        collisionClip.trackId,
        selectedClipIds,
        collisionClips,
      )
    ) {
      return null;
    }
  }

  return plannedMoves;
}
