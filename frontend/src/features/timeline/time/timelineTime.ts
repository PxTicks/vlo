import type { TimelineClip } from "../../../types/TimelineTypes";
import { calculateClipTime, mapSourceTimeToVisualTime } from "../../transformations/utils/timeCalculation";
import {
  buildTimelineClipPresentationLookup,
  buildTimelineClipPresentationCollisionView,
  introducesTimelineClipPresentationCollision,
  resolveClipOffsetForPresentationOffset,
  resolvePresentationOffsetForClipOffset,
  resolvePresentationTickForClipOffset,
  resolveStoredEndForPresentationEnd,
  type ProposedClipTimingChange,
  type TimelineClipPresentation as TimelineClipPresentationEngine,
  type TimelineClipPresentationLookup,
} from "./clipPresentation";
import {
  createTimelinePlacementMapper,
  type CreateTimelinePlacementMapperOptions,
  type TimelinePresentationRange,
  type TimelinePlacementMapper,
  type ProjectedTimelineRegion,
} from "./timelinePlacementMapper";
import { clipOffsetTick, presentationTick, sourceTick, storedTrackTick, timelineTimeValue, type ClipOffsetTick, type PresentationTick, type SourceTick, type StoredTrackTick, type TimelineTickDuration } from "../utils/timelineTimeDomains";

export type TimelineTimeSnapshot = CreateTimelinePlacementMapperOptions;
export type PresentationRange = TimelinePresentationRange;
export type TimelineClipPresentation = Pick<
  TimelineClipPresentationEngine,
  "clipId" | "trackId" | "start" | "end" | "duration"
>;
export interface TimelineTimeQueryOptions {
  includeMaskChildren?: boolean;
  trackIds?: readonly string[];
}

export interface TimelineTime extends TimelinePlacementMapper {
  footprint: TimelinePlacementMapper["getPresentationFootprint"];
  toStored: TimelinePlacementMapper["mapPresentationTickToStoredTick"];
  toPresentation: TimelinePlacementMapper["mapStoredTickToPresentationTick"];
  clipsAt(tick: PresentationTick, options?: TimelineTimeQueryOptions): TimelineClip[];
  clipsIn(range: PresentationRange, options?: TimelineTimeQueryOptions): TimelineClip[];
  /**
   * Source time the clip shows at `tick`. Not a footprint test: outside the
   * footprint it extrapolates through the clip's presentation (null only for an
   * unknown clip), which span edges at the exclusive end rely on. Ask
   * `footprint` or `clipsAt` first when the question is whether the clip plays.
   */
  sourceAt(clipId: string, tick: PresentationTick): SourceTick | null;
  presentationOf(clipId: string, source: SourceTick): PresentationTick | null;
  clampToFootprint(clipId: string, tick: number): PresentationTick | null;
  regionTopology(range: PresentationRange): TimelineClip[];
  projectRegion(range: PresentationRange, clipIds?: readonly string[], origin?: PresentationTick): ProjectedTimelineRegion;
  renderLookup(): TimelineClipPresentationLookup;
  snapshot(): TimelineTime;

  // --- Clip-local offsets (overlay geometry, snapping, drag readouts) ---
  // Offsets are relative to the clip's own footprint, not the timeline origin.
  // All three fall back to an identity mapping for a clip with no presentation
  // entry, so a mask child or an unplaced clip reads as untimed rather than
  // throwing.
  /** Presentation offset into the clip's footprint -> stored offset from `clip.start`. */
  toClipOffset(clipId: string, presentationOffset: TimelineTickDuration): ClipOffsetTick;
  /** Stored offset from `clip.start` -> presentation offset into the footprint. */
  toPresentationOffset(clipId: string, clipOffset: ClipOffsetTick): TimelineTickDuration;
  /** Stored offset from `clip.start` -> the absolute presentation tick showing it. */
  presentationTickForClipOffset(clipId: string, clipOffset: ClipOffsetTick): PresentationTick;

  // --- Placement inversion and collision (drag and drop) ---
  /** Stored end whose presentation end lands on `presentationEnd`, for right-resize. */
  resolveStoredEnd(clipId: string, presentationEnd: PresentationTick): StoredTrackTick | null;
  /**
   * Every clip's quantized footprint, keyed by clip id. Built once per snapshot,
   * so repeated reads within one interaction share it. Prefer `footprint` for a
   * single clip; take the index when scanning or passing placement down a tree.
   */
  presentationIndex(): ReadonlyMap<string, TimelineClipPresentation>;
  /**
   * The clips with `start`/`timelineDuration` restated in the presentation
   * domain, so the stored-time collision utilities test what the timeline draws.
   * `change` applies a proposed timing edit before resolving.
   */
  collisionView(change?: ProposedClipTimingChange): TimelineClip[];
  /** Whether `change` creates a presentation overlap that does not already exist. */
  introducesCollision(change: ProposedClipTimingChange): boolean;
}

function createTimelineTime(snapshot: TimelineTimeSnapshot): TimelineTime {
  const { tracks, clips, fps } = snapshot;
  const lookup = buildTimelineClipPresentationLookup(tracks, clips, fps);
  const mapper = createTimelinePlacementMapper(snapshot, lookup);
  const clipsById = new Map(clips.map((clip) => [clip.id, clip]));
  // Built on first ask and shared for the life of this snapshot: the UI reads
  // placement many times per interaction. Derive the public index from the
  // renderer lookup so both surfaces share the same presentation entries and
  // the track-time engines are built only once for this snapshot.
  let presentationIndex:
    | ReadonlyMap<string, TimelineClipPresentationEngine>
    | undefined;
  const index = () => {
    if (!presentationIndex) {
      presentationIndex = new Map(
        clips.flatMap((clip) => {
          const presentation = lookup.getPresentation(clip.id);
          return presentation ? [[clip.id, presentation] as const] : [];
        }),
      );
    }
    return presentationIndex;
  };
  const entryFor = (clipId: string) => index().get(clipId);
  const select = (ids: readonly string[], options: TimelineTimeQueryOptions = {}) => {
    const selected = new Set(ids);
    return clips.filter((clip) => selected.has(clip.id) &&
      (options.includeMaskChildren !== false || clip.type !== "mask") &&
      (!options.trackIds || options.trackIds.includes(clip.trackId)));
  };
  return {
    ...mapper,
    footprint: mapper.getPresentationFootprint,
    toStored: mapper.mapPresentationTickToStoredTick,
    toPresentation: mapper.mapStoredTickToPresentationTick,
    clipsAt(tick: PresentationTick, options?: TimelineTimeQueryOptions): TimelineClip[] {
      return select(mapper.getClipIdsAtPresentationTick(tick), options);
    },
    clipsIn(range: PresentationRange, options?: TimelineTimeQueryOptions): TimelineClip[] {
      return select(mapper.getClipIdsInPresentationRange(range), options);
    },
    sourceAt(clipId: string, tick: PresentationTick): SourceTick | null {
      const clip = clipsById.get(clipId);
      const stored = mapper.mapPresentationTickToStoredTick(clipId, tick);
      return clip && stored !== null
        ? sourceTick(calculateClipTime(clip, timelineTimeValue(stored) - clip.start, true))
        : null;
    },
    presentationOf(clipId: string, source: SourceTick): PresentationTick | null {
      const clip = clipsById.get(clipId);
      return clip ? mapper.mapStoredTickToPresentationTick(clipId,
        storedTrackTick(clip.start + mapSourceTimeToVisualTime(clip, source))) : null;
    },
    clampToFootprint(clipId: string, tick: number): PresentationTick | null {
      const range = mapper.getPresentationFootprint(clipId);
      return range ? presentationTick(Math.max(range.start, Math.min(range.end, tick))) : null;
    },
    regionTopology(range: PresentationRange): TimelineClip[] {
      return select(mapper.getRegionTopologyClipIds(range));
    },
    projectRegion(range: PresentationRange, clipIds?: readonly string[], origin?: PresentationTick) {
      return mapper.projectRegionToLocalTimeline(range, clipIds ?? mapper.getRegionTopologyClipIds(range), origin);
    },
    renderLookup: () => lookup,
    /** Isolate a multi-step mutation of an otherwise mutable draft. */
    snapshot(): TimelineTime {
      return createTimelineTimeSnapshot(snapshot);
    },
    toClipOffset(clipId: string, presentationOffset: TimelineTickDuration): ClipOffsetTick {
      return clipOffsetTick(resolveClipOffsetForPresentationOffset(entryFor(clipId), presentationOffset));
    },
    toPresentationOffset(clipId: string, clipOffset: ClipOffsetTick): TimelineTickDuration {
      return resolvePresentationOffsetForClipOffset(entryFor(clipId), clipOffset);
    },
    presentationTickForClipOffset(clipId: string, clipOffset: ClipOffsetTick): PresentationTick {
      const clip = clipsById.get(clipId);
      return presentationTick(clip
        ? resolvePresentationTickForClipOffset(clip, entryFor(clipId), clipOffset)
        : clipOffset);
    },
    resolveStoredEnd(clipId: string, presentationEnd: PresentationTick): StoredTrackTick | null {
      const clip = clipsById.get(clipId);
      return clip
        ? storedTrackTick(resolveStoredEndForPresentationEnd(tracks, clips, clip, presentationEnd))
        : null;
    },
    presentationIndex: index,
    collisionView(change?: ProposedClipTimingChange): TimelineClip[] {
      return buildTimelineClipPresentationCollisionView(tracks, clips, fps, change);
    },
    introducesCollision(change: ProposedClipTimingChange): boolean {
      return introducesTimelineClipPresentationCollision(tracks, clips, fps, change);
    },
  };
}



/** Make an isolated clock from the current contents of a mutable draft, bypassing the cache. */
export function createTimelineTimeSnapshot(snapshot: TimelineTimeSnapshot): TimelineTime {
  return createTimelineTime(structuredClone(snapshot));
}

// One bounded identity cache, shared by UI, authoring and render snapshots.
let cached: { snapshot: TimelineTimeSnapshot; time: TimelineTime } | undefined;
/**
 * Read an immutable state snapshot. Replace clips/tracks arrays when their contents
 * change. Mutable transactions must use createTimelinePlacementMapper (an isolated
 * snapshot) rather than reusing this identity-cached view after in-place edits.
 */
export function getTimelineTime(snapshot: TimelineTimeSnapshot): TimelineTime {
  if (!cached || cached.snapshot.tracks !== snapshot.tracks ||
      cached.snapshot.clips !== snapshot.clips || cached.snapshot.fps !== snapshot.fps) {
    cached = { snapshot: { ...snapshot }, time: createTimelineTime(snapshot) };
  }
  return cached.time;
}
