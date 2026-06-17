import type {
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import {
  buildTimelineClipPresentationIndex,
  type TimelineClipPresentation,
} from "../../timeline/utils/clipPresentation";

interface FindClipAtPointInput {
  tracks: readonly TimelineTrack[];
  clips: readonly TimelineClip[];
  fps: number;
  trackId: string;
  tick: number;
}

export function findClipAtPoint({
  tracks,
  clips,
  fps,
  trackId,
  tick,
}: FindClipAtPointInput): TimelineClip | null {
  const presentationByClipId = buildTimelineClipPresentationIndex(
    tracks,
    clips,
    fps,
  );

  const candidates = clips
    .filter((clip) => clip.type !== "mask" && clip.trackId === trackId)
    .map((clip) => ({
      clip,
      presentation: presentationByClipId.get(clip.id),
    }))
    .filter(
      (
        entry,
      ): entry is {
        clip: TimelineClip;
        presentation: TimelineClipPresentation;
      } => entry.presentation !== undefined,
    )
    .sort((left, right) => left.presentation.start - right.presentation.start);

  const match = candidates.find(
    ({ presentation }) => tick >= presentation.start && tick < presentation.end,
  );

  return match?.clip ?? null;
}
