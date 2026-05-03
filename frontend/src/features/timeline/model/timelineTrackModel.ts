import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import type { TimelineSnapshot } from "../../project/types/ProjectDocument";

export interface TimelineModelState {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
}

export const generateTrackId = () => `track_${crypto.randomUUID()}`;

export function createNewTrack(label: string): TimelineTrack {
  return {
    id: generateTrackId(),
    label,
    isVisible: true,
    isLocked: false,
    isMuted: false,
  };
}

export function createDefaultTimelineSnapshot(): TimelineSnapshot {
  return {
    tracks: [createNewTrack("Track 1")],
    clips: [],
  };
}

export function maybeTrimAndPadTracks(model: TimelineModelState): void {
  const { tracks, clips } = model;

  const hasClips = (trackId: string) =>
    clips.some((clip) => clip.trackId === trackId && clip.type !== "mask");

  const populatedIndices = tracks
    .map((track, index) => (hasClips(track.id) ? index : -1))
    .filter((index) => index !== -1);

  if (populatedIndices.length === 0) {
    if (tracks.length === 1 && !hasClips(tracks[0].id)) return;
    model.tracks = [createNewTrack("Track 1")];
    return;
  }

  const firstIndex = populatedIndices[0];
  const lastIndex = populatedIndices[populatedIndices.length - 1];

  const coreTracks = tracks
    .slice(firstIndex, lastIndex + 1)
    .filter((track) => hasClips(track.id));

  const topPadding =
    firstIndex > 0 ? tracks[firstIndex - 1] : createNewTrack("Track Top");
  const bottomPadding =
    lastIndex < tracks.length - 1
      ? tracks[lastIndex + 1]
      : createNewTrack("Track Bottom");

  const newTracks = [topPadding, ...coreTracks, bottomPadding].map((track, i) => ({
    ...track,
    label: `Track ${i + 1}`,
  }));

  const currentIds = tracks.map((track) => track.id).join(",");
  const nextIds = newTracks.map((track) => track.id).join(",");

  if (currentIds === nextIds) return;

  model.tracks = newTracks;
}
