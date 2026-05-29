import type {
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { ADJUSTMENT_RETIMING_RIPPLE } from "../../../types/TimelineTypes";
import {
  buildTrackTimeResolver,
  type TrackTimeResolver,
} from "../../renderer/utils/resolveTrackTime";

const COLLISION_EPSILON_TICKS = 0.5;

export interface TimelineClipPresentation {
  clipId: string;
  trackId: string;
  /** On-screen start after applying ripple retiming and static rebases. */
  start: number;
  end: number;
  duration: number;
  /**
   * Given a presentation-offset within this clip's footprint, return the
   * stored offset within the clip (i.e. `effectiveTrackTick - clip.start`).
   * Uses the internal `TrackTimeResolver` after applying the clip's selected
   * static/ripple placement model, so spline speed transforms are honoured
   * exactly.
   */
  mapPresentationOffsetToClipOffset: (presentationOffset: number) => number;
  /**
   * Given a stored offset within the clip, return where that source-owned
   * position appears inside the clip's presentation footprint.
   */
  mapClipOffsetToPresentationOffset: (clipOffset: number) => number;
}

export interface TimelineClipPresentationCollision {
  trackId: string;
  leftClipId: string;
  rightClipId: string;
}

export interface ProposedClipTimingChange {
  clipId: string;
  trackId?: string;
  transformations?: ClipTransform[];
  timelineDuration?: number;
  transformedDuration?: number;
  transformedOffset?: number;
  croppedSourceDuration?: number;
  offset?: number;
  start?: number;
}

/**
 * Renderer/audio-renderer facing index. Wraps the presentation map with an
 * active-clip lookup keyed by presentation tick, plus an effective-track-tick
 * resolver that hides static rebases and ripple placement.
 */
export interface TimelineClipPresentationLookup {
  readonly byClipId: Map<string, TimelineClipPresentation>;
  /**
   * Return the clip whose presentation footprint contains `presentationTick`
   * on `trackId`, plus the corresponding `effectiveTrackTick` (the value the
   * presentation model emits for that clip — feed it straight into
   * `calculatePlayerFrameTime` / `calculateClipTime`).
   */
  findActiveClipAt(
    trackId: string,
    presentationTick: number,
  ): {
    clip: TimelineClip;
    effectiveTick: number;
    /** The tick visual adjustment grouping should use for activation. */
    presentationInputTick: number;
  } | null;
  /**
   * Map a presentation tick that is known to fall within `clip`'s footprint
   * to the corresponding effective track tick. Returns the input unchanged
   * if the clip has no presentation entry (defensive identity).
   */
  resolveEffectiveTrackTickWithinClip(
    clip: TimelineClip,
    presentationTick: number,
  ): number;
}

/**
 * Internal augmented presentation entry. Carries the per-clip rebase state
 * needed by `findActiveClipAt` without exposing it to UI consumers.
 */
interface InternalClipPresentation extends TimelineClipPresentation {
  resolveEffectiveTrackTick: (presentationTick: number) => number;
  resolvePresentationInputTick: (presentationTick: number) => number;
  clipRef: TimelineClip;
}

export function resolveClipOffsetForPresentationOffset(
  presentation: TimelineClipPresentation | undefined,
  presentationOffset: number,
): number {
  return (
    presentation?.mapPresentationOffsetToClipOffset(presentationOffset) ??
    presentationOffset
  );
}

export function resolvePresentationOffsetForClipOffset(
  presentation: TimelineClipPresentation | undefined,
  clipOffset: number,
): number {
  return (
    presentation?.mapClipOffsetToPresentationOffset(clipOffset) ?? clipOffset
  );
}

export function resolvePresentationTickForClipOffset(
  clip: TimelineClip,
  presentation: TimelineClipPresentation | undefined,
  clipOffset: number,
): number {
  return (
    (presentation?.start ?? clip.start) +
    resolvePresentationOffsetForClipOffset(presentation, clipOffset)
  );
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
    trackId: change.trackId ?? clip.trackId,
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

function buildRippleLayoutResolver(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
): TrackTimeResolver {
  return buildTrackTimeResolver(tracks, clips, {
    retimingModes: [ADJUSTMENT_RETIMING_RIPPLE],
  });
}

function buildPresentation(
  clip: TimelineClip,
  resolver: TrackTimeResolver,
  layoutResolver: TrackTimeResolver,
): InternalClipPresentation {
  // Ripple-mode adjustments choose the clip's lane position. Static-mode
  // adjustments are then rebased around that position so they retime only the
  // clip content they visibly cover, not every later clip on the track.
  const start = layoutResolver.resolvePresentationTick(
    clip.trackId,
    clip.start,
  );
  const baseEffectiveTick = resolver.resolveEffectiveTrackTick(
    clip.trackId,
    start,
  );
  const presentationEnd = resolver.resolvePresentationTick(
    clip.trackId,
    baseEffectiveTick + clip.timelineDuration,
  );
  const duration = Math.max(0, presentationEnd - start);
  const end = start + duration;

  const resolveEffectiveTrackTick = (presentationTick: number): number => {
    const effectiveTick = resolver.resolveEffectiveTrackTick(
      clip.trackId,
      presentationTick,
    );
    return clip.start + (effectiveTick - baseEffectiveTick);
  };
  const resolvePresentationInputTick = (presentationTick: number): number =>
    presentationTick;

  return {
    clipId: clip.id,
    trackId: clip.trackId,
    start,
    end,
    duration,
    mapPresentationOffsetToClipOffset(presentationOffset) {
      return resolveEffectiveTrackTick(start + presentationOffset) - clip.start;
    },
    mapClipOffsetToPresentationOffset(clipOffset) {
      return (
        resolver.resolvePresentationTick(
          clip.trackId,
          baseEffectiveTick + clipOffset,
        ) - start
      );
    },
    resolveEffectiveTrackTick,
    resolvePresentationInputTick,
    clipRef: clip,
  };
}

function indexClipsByTrack(
  presentationByClipId: Map<string, InternalClipPresentation>,
): Map<string, InternalClipPresentation[]> {
  const byTrack = new Map<string, InternalClipPresentation[]>();
  for (const presentation of presentationByClipId.values()) {
    const list = byTrack.get(presentation.trackId) ?? [];
    list.push(presentation);
    byTrack.set(presentation.trackId, list);
  }
  for (const list of byTrack.values()) {
    list.sort((left, right) => left.start - right.start);
  }
  return byTrack;
}

function buildInternalPresentationMap(
  resolver: TrackTimeResolver,
  layoutResolver: TrackTimeResolver,
  clips: readonly TimelineClip[],
): Map<string, InternalClipPresentation> {
  const presentationByClipId = new Map<string, InternalClipPresentation>();
  for (const clip of clips) {
    if (clip.type === "mask") continue;
    presentationByClipId.set(
      clip.id,
      buildPresentation(clip, resolver, layoutResolver),
    );
  }
  return presentationByClipId;
}

/**
 * UI-facing presentation index: a plain `Map<clipId, presentation>` whose
 * entries describe each clip's on-screen footprint. Static adjustment retiming
 * pins descendant clip starts; ripple retiming stretches/contracts the lane and
 * shifts later clips through the same global warp used by the renderer.
 */
export function buildTimelineClipPresentationIndex(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
): Map<string, TimelineClipPresentation> {
  const resolver = buildTrackTimeResolver(tracks, clips);
  const layoutResolver = buildRippleLayoutResolver(tracks, clips);
  const internalMap = buildInternalPresentationMap(
    resolver,
    layoutResolver,
    clips,
  );
  const publicMap = new Map<string, TimelineClipPresentation>();
  for (const [clipId, presentation] of internalMap) {
    publicMap.set(clipId, presentation);
  }
  return publicMap;
}

/**
 * Renderer-facing index: same presentation map plus the active-clip lookup the
 * renderer / audio engine consume. The lookup encapsulates static rebases and
 * ripple placement so call sites no longer touch the internal resolver.
 */
export function buildTimelineClipPresentationLookup(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
): TimelineClipPresentationLookup {
  const resolver = buildTrackTimeResolver(tracks, clips);
  const layoutResolver = buildRippleLayoutResolver(tracks, clips);
  const internalMap = buildInternalPresentationMap(
    resolver,
    layoutResolver,
    clips,
  );
  const byTrack = indexClipsByTrack(internalMap);

  const byClipId = new Map<string, TimelineClipPresentation>();
  for (const [clipId, presentation] of internalMap) {
    byClipId.set(clipId, presentation);
  }

  return {
    byClipId,
    findActiveClipAt(trackId, presentationTick) {
      const list = byTrack.get(trackId);
      if (!list || list.length === 0) return null;
      let low = 0;
      let high = list.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const entry = list[mid];
        if (presentationTick < entry.start) {
          high = mid - 1;
        } else if (presentationTick >= entry.end) {
          low = mid + 1;
        } else {
          return {
            clip: entry.clipRef,
            effectiveTick: entry.resolveEffectiveTrackTick(presentationTick),
            presentationInputTick:
              entry.resolvePresentationInputTick(presentationTick),
          };
        }
      }
      return null;
    },
    resolveEffectiveTrackTickWithinClip(clip, presentationTick) {
      const entry = internalMap.get(clip.id);
      if (!entry) return presentationTick;
      return entry.resolveEffectiveTrackTick(presentationTick);
    },
  };
}

/**
 * For DnD right-resize: compute the new stored end such that the clip's
 * presentation end lands at `targetPresentationEnd` under its selected
 * static/ripple placement model.
 */
export function resolveStoredEndForPresentationEnd(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  clip: TimelineClip,
  targetPresentationEnd: number,
): number {
  const resolver = buildTrackTimeResolver(tracks, clips);
  const layoutResolver = buildRippleLayoutResolver(tracks, clips);
  const presentationStart = layoutResolver.resolvePresentationTick(
    clip.trackId,
    clip.start,
  );
  const baseEffectiveTick = resolver.resolveEffectiveTrackTick(
    clip.trackId,
    presentationStart,
  );
  const targetEffectiveTick = resolver.resolveEffectiveTrackTick(
    clip.trackId,
    targetPresentationEnd,
  );
  return clip.start + (targetEffectiveTick - baseEffectiveTick);
}

/**
 * Invert the placement part of the presentation model. Drag/drop works in
 * presentation coordinates; committed clips store track-time coordinates.
 * Static adjustments are ignored for placement, while ripple adjustments use
 * the global inverse so the final rendered start lands under the cursor.
 */
export function resolveStoredStartForPresentationStart(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  trackId: string,
  targetPresentationStart: number,
): number {
  return buildRippleLayoutResolver(tracks, clips).resolveEffectiveTrackTick(
    trackId,
    targetPresentationStart,
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

/**
 * Adapter for legacy collision utilities. They already understand
 * `{ start, timelineDuration }`; this view simply feeds those fields in the
 * presentation domain while preserving every other clip property.
 */
export function buildTimelineClipPresentationCollisionView(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  change?: ProposedClipTimingChange,
): TimelineClip[] {
  const nextClips = change
    ? clips.map((clip) => applyProposedClipTimingChange(clip, change))
    : [...clips];
  const presentationByClipId = buildTimelineClipPresentationIndex(
    tracks,
    nextClips,
  );

  return nextClips.map((clip) => {
    const presentation = presentationByClipId.get(clip.id);
    if (!presentation) return clip;
    return {
      ...clip,
      start: Math.round(presentation.start),
      timelineDuration: Math.round(presentation.duration),
    };
  });
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
