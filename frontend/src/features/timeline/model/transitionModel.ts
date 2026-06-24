import type {
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../../types/TimelineTypes";
import {
  buildTimelineClipPresentationIndex,
  type TimelineClipPresentation,
} from "../utils/clipPresentation";

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

export interface TransitionResolutionContext {
  tracks: readonly TimelineTrack[];
  clipsById: ReadonlyMap<string, TimelineClip>;
  trackIndexById: ReadonlyMap<string, number>;
  presentationByClipId: ReadonlyMap<string, TimelineClipPresentation>;
}

function isVisualTrack(track: TimelineTrack | undefined): boolean {
  return track?.type === "visual";
}

export function buildTransitionResolutionContext(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  fps: number,
): TransitionResolutionContext {
  return {
    tracks,
    clipsById: new Map(clips.map((clip) => [clip.id, clip] as const)),
    trackIndexById: new Map(
      tracks.map((track, index) => [track.id, index] as const),
    ),
    presentationByClipId: buildTimelineClipPresentationIndex(
      tracks,
      clips,
      fps,
    ),
  };
}

export function resolveTransitionFromContext(
  transition: Transition,
  context: TransitionResolutionContext,
): ResolvedTransition | null {
  const outgoingClip = context.clipsById.get(transition.outgoingClipId);
  const incomingClip = context.clipsById.get(transition.incomingClipId);
  if (!outgoingClip || !incomingClip || outgoingClip.id === incomingClip.id) {
    return null;
  }
  if (outgoingClip.type === "mask" || incomingClip.type === "mask") {
    return null;
  }

  const outgoingTrackIndex =
    context.trackIndexById.get(outgoingClip.trackId) ?? -1;
  const incomingTrackIndex =
    context.trackIndexById.get(incomingClip.trackId) ?? -1;
  if (
    outgoingTrackIndex < 0 ||
    incomingTrackIndex < 0 ||
    Math.abs(outgoingTrackIndex - incomingTrackIndex) !== 1 ||
    !isVisualTrack(context.tracks[outgoingTrackIndex]) ||
    !isVisualTrack(context.tracks[incomingTrackIndex])
  ) {
    return null;
  }

  const outgoingPresentation = context.presentationByClipId.get(
    outgoingClip.id,
  );
  const incomingPresentation = context.presentationByClipId.get(
    incomingClip.id,
  );
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

export function resolveTransition(
  transition: Transition,
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  fps: number,
): ResolvedTransition | null {
  return resolveTransitionFromContext(
    transition,
    buildTransitionResolutionContext(tracks, clips, fps),
  );
}

export function isTransitionValid(
  transition: Transition,
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  fps: number,
): boolean {
  return resolveTransition(transition, tracks, clips, fps) !== null;
}

export function resolveTransitions(
  transitions: readonly Transition[],
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  fps: number,
): ResolvedTransition[] {
  const context = buildTransitionResolutionContext(tracks, clips, fps);
  const resolvedTransitions: ResolvedTransition[] = [];
  for (const transition of transitions) {
    const resolved = resolveTransitionFromContext(transition, context);
    if (resolved) {
      resolvedTransitions.push(resolved);
    }
  }
  return resolvedTransitions;
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
  const context = buildTransitionResolutionContext(tracks, clips, fps);
  const activeTransitions: ResolvedTransition[] = [];
  for (const transition of transitions) {
    const resolved = resolveTransitionFromContext(transition, context);
    if (
      resolved &&
      presentationTick >= resolved.start &&
      presentationTick < resolved.end
    ) {
      activeTransitions.push(resolved);
    }
  }
  return activeTransitions;
}
