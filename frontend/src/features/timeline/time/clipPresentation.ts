import type {
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { ADJUSTMENT_RETIMING_RIPPLE } from "../../../types/TimelineTypes";
import {
  buildTrackTimeResolver,
  trackTimeWarpsEqual,
  type TrackTimeResolver,
  type TrackTimeWarp,
} from "./resolveTrackTime";
import { snapTickToFrameGrid, ticksPerFrame } from "../../../core/time/frameGrid";

export interface TimelineClipPresentation {
  clipId: string;
  trackId: string;
  /**
   * On-screen footprint, quantized to the frame grid — this IS the render
   * reality (which whole frames the clip occupies): epsilon-tolerant ceiling on
   * both boundaries, >= 1 frame, integer ticks. Display geometry, selection
   * (`findActiveClipAt`), collision, snapping, and timeline length all read this
   * one footprint, so the drawn rectangle, the rendered frames, and the
   * frame-snapped playhead always agree. The continuous source<->presentation
   * mapping (which can be fractional) lives in the offset mappers /
   * `resolveEffectiveTrackTick` below, not in these boundary fields.
   */
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
  /**
   * Return the **id** of the clip whose presentation footprint contains
   * `presentationTick` on `trackId`, plus the corresponding `effectiveTrackTick`
   * (the value the presentation model emits for that clip — feed it straight
   * into `calculatePlayerFrameTime` / `calculateClipTime`).
   *
   * Clip-resolution principle: this lookup owns **identity + timing** ("which
   * clip, and when"), never **data** ("what's in the clip"). Its entries are a
   * snapshot taken when the lookup was built (invalidated on a React effect via
   * `setAdjustmentSource`), so it returns an id rather than a clip object — read
   * the clip's current data from the live store/`trackClips` by id (see
   * `resolveLiveActiveClip`). Returning a cached clip object here is exactly how
   * committed edits used to visibly revert.
   */
  findActiveClipAt(
    trackId: string,
    presentationTick: number,
  ): {
    clipId: string;
    effectiveTick: number;
    /** The tick visual adjustment grouping should use for activation. */
    presentationInputTick: number;
  } | null;
  /** Quantized visible start for a clip, or null when it has no presentation. */
  getPresentationStart(clipId: string): number | null;
  /** The clip's presentation entry, or null when it has none (mask clips). */
  getPresentation(clipId: string): TimelineClipPresentation | null;
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
}

/**
 * Everything `buildPresentation` reads. When all of it matches, a previous
 * entry maps every tick the same way and can be reused as is.
 */
interface PresentationInputs {
  fps: number;
  trackId: string;
  storedStart: number;
  storedDuration: number;
  warp: TrackTimeWarp;
  layoutWarp: TrackTimeWarp;
}

interface ReusablePresentation {
  inputs: PresentationInputs;
  presentation: InternalClipPresentation;
}

// Keyed by lookup so callers pass the lookup back rather than a reuse handle.
const reusableEntriesByLookup = new WeakMap<
  TimelineClipPresentationLookup,
  ReadonlyMap<string, ReusablePresentation>
>();

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

  const next = {
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
    offset:
      change.offset !== undefined ? Math.round(change.offset) : clip.offset,
  };

  if (next.type === "adjustment") {
    next.sourceDuration = next.croppedSourceDuration;
  }

  return next;
}

function buildRippleLayoutResolver(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
): TrackTimeResolver {
  return buildTrackTimeResolver(tracks, clips, {
    retimingModes: [ADJUSTMENT_RETIMING_RIPPLE],
  });
}

/**
 * Quantize a raw (continuous) presentation footprint to the integer frame grid.
 * Epsilon-tolerant ceiling on BOTH boundaries so that:
 *  - adjacent abutting clips (whose shared boundary the resolver maps to the
 *    same tick) quantize identically and stay abutting (no gap / no overlap);
 *  - the final partial content frame is included (never truncates below the
 *    clip's content), while an already-frame-aligned boundary is NOT pushed to
 *    the next frame by floating-point error;
 *  - every clip occupies at least one frame.
 */
export function computeQuantizedPresentation(
  rawStart: number,
  rawEnd: number,
  fps: number,
): { startTick: number; endTick: number; durationTicks: number } {
  const startTick = snapTickToFrameGrid(rawStart, fps, "ceil");
  let endTick = snapTickToFrameGrid(rawEnd, fps, "ceil");
  if (endTick <= startTick) {
    endTick = startTick + ticksPerFrame(fps);
  }
  return { startTick, endTick, durationTicks: endTick - startTick };
}

function buildPresentation(
  clip: TimelineClip,
  { fps, trackId, storedStart, storedDuration, warp, layoutWarp }: PresentationInputs,
): InternalClipPresentation {
  // Ripple-mode adjustments choose the clip's lane position. Static-mode
  // adjustments are then rebased around that position so they retime only the
  // clip content they visibly cover, not every later clip on the track.
  const rawStart = layoutWarp.resolvePresentationTick(storedStart);
  const baseEffectiveTick = warp.resolveEffectiveTrackTick(rawStart);
  const rawPresentationEnd = warp.resolvePresentationTick(
    baseEffectiveTick + storedDuration,
  );
  const rawEnd = rawStart + Math.max(0, rawPresentationEnd - rawStart);
  // The footprint IS the frame grid the renderer samples — quantize the raw
  // (possibly fractional, source-derived) span up to whole frames. Offsets
  // below are expressed relative to this quantized start so markers/snapping
  // sit inside the same rectangle; the decode mapping stays continuous (raw
  // `baseEffectiveTick`) so a frame tick still maps to the true source frame.
  const { startTick, endTick, durationTicks } = computeQuantizedPresentation(
    rawStart,
    rawEnd,
    fps,
  );

  const resolveEffectiveTrackTick = (presentationTick: number): number =>
    storedStart +
    (warp.resolveEffectiveTrackTick(presentationTick) - baseEffectiveTick);
  const resolvePresentationInputTick = (presentationTick: number): number =>
    presentationTick;

  return {
    clipId: clip.id,
    trackId,
    start: startTick,
    end: endTick,
    duration: durationTicks,
    mapPresentationOffsetToClipOffset(presentationOffset) {
      return (
        resolveEffectiveTrackTick(startTick + presentationOffset) - storedStart
      );
    },
    mapClipOffsetToPresentationOffset(clipOffset) {
      return (
        warp.resolvePresentationTick(baseEffectiveTick + clipOffset) - startTick
      );
    },
    resolveEffectiveTrackTick,
    resolvePresentationInputTick,
  };
}

function presentationInputsEqual(
  left: PresentationInputs,
  right: PresentationInputs,
): boolean {
  return (
    left.fps === right.fps &&
    left.trackId === right.trackId &&
    left.storedStart === right.storedStart &&
    left.storedDuration === right.storedDuration &&
    trackTimeWarpsEqual(left.warp, right.warp) &&
    trackTimeWarpsEqual(left.layoutWarp, right.layoutWarp)
  );
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
  fps: number,
  previous?: ReadonlyMap<string, ReusablePresentation>,
): {
  presentations: Map<string, InternalClipPresentation>;
  reusable: Map<string, ReusablePresentation>;
} {
  const presentations = new Map<string, InternalClipPresentation>();
  const reusable = new Map<string, ReusablePresentation>();
  for (const clip of clips) {
    if (clip.type === "mask") continue;
    const inputs: PresentationInputs = {
      fps,
      trackId: clip.trackId,
      storedStart: clip.start,
      storedDuration: clip.timelineDuration,
      warp: resolver.forTrack(clip.trackId),
      layoutWarp: layoutResolver.forTrack(clip.trackId),
    };
    // Reusing the entry keeps its identity across snapshots, so memoized UI
    // keyed on it skips clips whose placement did not change.
    const prior = previous?.get(clip.id);
    const entry =
      prior && presentationInputsEqual(prior.inputs, inputs)
        ? prior
        : { inputs, presentation: buildPresentation(clip, inputs) };
    presentations.set(clip.id, entry.presentation);
    reusable.set(clip.id, entry);
  }
  return { presentations, reusable };
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
  fps: number,
): Map<string, TimelineClipPresentation> {
  const resolver = buildTrackTimeResolver(tracks, clips);
  const layoutResolver = buildRippleLayoutResolver(tracks, clips);
  const { presentations: internalMap } = buildInternalPresentationMap(
    resolver,
    layoutResolver,
    clips,
    fps,
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
 *
 * Pass the previous snapshot's lookup as `previous` to keep its entry objects
 * for clips whose placement inputs are unchanged. Reuse is decided by value,
 * so any earlier lookup is safe to pass, even one from another timeline.
 */
export function buildTimelineClipPresentationLookup(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  fps: number,
  previous?: TimelineClipPresentationLookup,
): TimelineClipPresentationLookup {
  const resolver = buildTrackTimeResolver(tracks, clips);
  const layoutResolver = buildRippleLayoutResolver(tracks, clips);
  const { presentations: internalMap, reusable } =
    buildInternalPresentationMap(
      resolver,
      layoutResolver,
      clips,
      fps,
      previous ? reusableEntriesByLookup.get(previous) : undefined,
    );
  const byTrack = indexClipsByTrack(internalMap);

  const lookup: TimelineClipPresentationLookup = {
    findActiveClipAt(trackId, presentationTick) {
      const list = byTrack.get(trackId);
      if (!list || list.length === 0) return null;
      let low = 0;
      let high = list.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const entry = list[mid];
        // Half-open [start, end) on the integer frame grid: a frame boundary
        // tick equal to a clip's start is owned by that clip; the tick equal to
        // its end belongs to the next clip. Integer bounds make this exact — no
        // tolerance, and a clip starting on a boundary always renders that frame.
        if (presentationTick < entry.start) {
          high = mid - 1;
        } else if (presentationTick >= entry.end) {
          low = mid + 1;
        } else {
          return {
            clipId: entry.clipId,
            effectiveTick: entry.resolveEffectiveTrackTick(presentationTick),
            presentationInputTick:
              entry.resolvePresentationInputTick(presentationTick),
          };
        }
      }
      return null;
    },
    getPresentationStart(clipId) {
      return internalMap.get(clipId)?.start ?? null;
    },
    getPresentation(clipId) {
      return internalMap.get(clipId) ?? null;
    },
    resolveEffectiveTrackTickWithinClip(clip, presentationTick) {
      const entry = internalMap.get(clip.id);
      if (!entry) return presentationTick;
      return entry.resolveEffectiveTrackTick(presentationTick);
    },
  };
  reusableEntriesByLookup.set(lookup, reusable);
  return lookup;
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
    // Quantized integer footprints — sort and overlap-test are exact, no
    // tolerance. A clip ending exactly where the next starts (end === start) is
    // a clean half-open abut, not a collision.
    placements.sort((left, right) => {
      const startDelta = left.start - right.start;
      return startDelta !== 0 ? startDelta : left.end - right.end;
    });

    for (let index = 1; index < placements.length; index += 1) {
      const previous = placements[index - 1];
      const current = placements[index];
      if (previous.end > current.start) {
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
  fps: number,
): TimelineClipPresentationCollision[] {
  return collectPresentationCollisionsFromIndex(
    buildTimelineClipPresentationIndex(tracks, clips, fps),
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
  fps: number,
  change?: ProposedClipTimingChange,
): TimelineClip[] {
  const nextClips = change
    ? clips.map((clip) => applyProposedClipTimingChange(clip, change))
    : [...clips];
  const presentationByClipId = buildTimelineClipPresentationIndex(
    tracks,
    nextClips,
    fps,
  );

  return nextClips.map((clip) => {
    const presentation = presentationByClipId.get(clip.id);
    if (!presentation) return clip;
    // Feed legacy collision utilities the quantized frame-grid footprint so
    // their notion of overlap matches the renderer's selection grid exactly.
    return {
      ...clip,
      start: presentation.start,
      timelineDuration: presentation.duration,
    };
  });
}

export function introducesTimelineClipPresentationCollision(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  fps: number,
  change: ProposedClipTimingChange,
): boolean {
  const beforeCollisions = new Set(
    collectTimelineClipPresentationCollisions(tracks, clips, fps).map(
      collisionKey,
    ),
  );
  const nextClips = clips.map((clip) =>
    applyProposedClipTimingChange(clip, change),
  );

  return collectTimelineClipPresentationCollisions(tracks, nextClips, fps).some(
    (collision) => !beforeCollisions.has(collisionKey(collision)),
  );
}

// Single-entry memo of the presentation lookup, keyed on the (tracks, clips,
// fps) snapshot identity. Authoring callers (keyframe commit/toggle/display)
// resolve the effective tick once per playback frame; rebuilding the full
// presentation map each frame would be wasteful, and the store hands back stable
// array refs between edits so this hits on every frame during playback.
let effectiveTickLookupCache: {
  tracks: readonly TimelineTrack[];
  clips: readonly TimelineClip[];
  fps: number;
  lookup: TimelineClipPresentationLookup;
} | null = null;

function getMemoizedPresentationLookup(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  fps: number,
): TimelineClipPresentationLookup {
  if (
    !effectiveTickLookupCache ||
    effectiveTickLookupCache.tracks !== tracks ||
    effectiveTickLookupCache.clips !== clips ||
    effectiveTickLookupCache.fps !== fps
  ) {
    effectiveTickLookupCache = {
      tracks,
      clips,
      fps,
      lookup: buildTimelineClipPresentationLookup(tracks, clips, fps),
    };
  }
  return effectiveTickLookupCache.lookup;
}

/**
 * Map a presentation (playhead) tick to a clip's effective track tick, applying
 * the same adjustment-layer retiming the renderer uses (`getPresentationLookup`
 * on the renderer side). Authoring code must resolve keyframe times through this
 * so an adjustment clip's speed retimes *which source frame* a keyframe edit /
 * toggle / display lands on — matching what the viewer shows. A no-op (identity)
 * when the clip sits under no adjustment retiming.
 */
export function resolveClipEffectiveTrackTick(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  fps: number,
  clip: TimelineClip,
  presentationTick: number,
): number {
  return getMemoizedPresentationLookup(
    tracks,
    clips,
    fps,
  ).resolveEffectiveTrackTickWithinClip(clip, presentationTick);
}

/**
 * The clip's presentation entry within a timeline snapshot, from the same
 * memoized lookup as `resolveClipEffectiveTrackTick`. Null for clips with no
 * presentation of their own (mask clips).
 */
export function resolveClipPresentation(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  fps: number,
  clip: TimelineClip,
): TimelineClipPresentation | null {
  return getMemoizedPresentationLookup(tracks, clips, fps).getPresentation(
    clip.id,
  );
}
