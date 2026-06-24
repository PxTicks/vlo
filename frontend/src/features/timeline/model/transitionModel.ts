import type {
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../../types/TimelineTypes";
import { buildTimelineClipPresentationIndex } from "../utils/clipPresentation";

export interface TransitionWindow {
  start: number;
  end: number;
  duration: number;
  outgoingTrackIndex: number;
  incomingTrackIndex: number;
}

export interface ResolvedTransition extends TransitionWindow {
  transition: Transition;
  outgoingClip: TimelineClip;
  incomingClip: TimelineClip;
}

function isVisualTrack(track: TimelineTrack | undefined): boolean {
  return track?.type === "visual";
}

export function resolveTransition(
  transition: Transition,
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  fps: number,
): ResolvedTransition | null {
  const outgoingClip = clips.find(
    (clip) => clip.id === transition.outgoingClipId && clip.type !== "mask",
  );
  const incomingClip = clips.find(
    (clip) => clip.id === transition.incomingClipId && clip.type !== "mask",
  );
  if (!outgoingClip || !incomingClip || outgoingClip.id === incomingClip.id) {
    return null;
  }

  const outgoingTrackIndex = tracks.findIndex(
    (track) => track.id === outgoingClip.trackId,
  );
  const incomingTrackIndex = tracks.findIndex(
    (track) => track.id === incomingClip.trackId,
  );
  if (
    outgoingTrackIndex < 0 ||
    incomingTrackIndex < 0 ||
    Math.abs(outgoingTrackIndex - incomingTrackIndex) !== 1 ||
    !isVisualTrack(tracks[outgoingTrackIndex]) ||
    !isVisualTrack(tracks[incomingTrackIndex])
  ) {
    return null;
  }

  const presentationById = buildTimelineClipPresentationIndex(
    [...tracks],
    [...clips],
    fps,
  );
  const outgoingPresentation = presentationById.get(outgoingClip.id);
  const incomingPresentation = presentationById.get(incomingClip.id);
  if (!outgoingPresentation || !incomingPresentation) {
    return null;
  }

  const start = Math.max(
    outgoingPresentation.start,
    incomingPresentation.start,
  );
  const end = Math.min(outgoingPresentation.end, incomingPresentation.end);
  if (end <= start) {
    return null;
  }

  return {
    transition,
    outgoingClip,
    incomingClip,
    start,
    end,
    duration: end - start,
    outgoingTrackIndex,
    incomingTrackIndex,
  };
}

export function isTransitionValid(
  transition: Transition,
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  fps: number,
): boolean {
  return resolveTransition(transition, tracks, clips, fps) !== null;
}

export function resolveTransitionProgress(
  window: Pick<TransitionWindow, "start" | "end">,
  presentationTick: number,
): number {
  if (window.end <= window.start) return 0;
  return Math.max(
    0,
    Math.min(1, (presentationTick - window.start) / (window.end - window.start)),
  );
}

export function resolveActiveTransitions(
  transitions: readonly Transition[],
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  fps: number,
  presentationTick: number,
): ResolvedTransition[] {
  return transitions.flatMap((transition) => {
    const resolved = resolveTransition(transition, tracks, clips, fps);
    if (
      !resolved ||
      presentationTick < resolved.start ||
      presentationTick >= resolved.end
    ) {
      return [];
    }
    return [resolved];
  });
}
