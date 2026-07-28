import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
// Deep import (not the feature index) so the timeline API layer does not pull
// the whole transformations barrel into an import cycle — the same shape
// `clipMath` and `snapDragOverlay` already use.
import { presentationToClipSourceTime } from "../../transformations/utils/clipTimeDomains";
import {
  createTimelinePlacementMapper,
  type TimelinePlacementMapper,
} from "../utils/timelinePlacementMapper";
import { presentationTick } from "../utils/timelineTimeDomains";

/**
 * Where a new marker lands: the clip that owns it, and the source-media time
 * (project ticks) the marker is anchored to.
 */
export interface MarkerPlacement {
  clipId: string;
  sourceTimeTicks: number;
}

export interface PlayheadCoverageInput {
  tracks: readonly TimelineTrack[];
  clips: readonly TimelineClip[];
  fps: number;
  /** Global playhead tick, in presentation time (what the ruler shows). */
  presentationTick: number;
  /**
   * Keep the mask clips whose parent is covered. Masks never match on their own
   * footprint — they ride along with the clip they belong to, which selection
   * and composite grouping need. Actions that operate on the clip itself
   * (markers, beat detection) leave this off.
   */
  includeMaskChildren?: boolean;
}

export interface ResolveMarkerPlacementsInput extends PlayheadCoverageInput {
  /** Selected clips win when the playhead covers several. */
  preferredClipIds?: readonly string[];
}

/**
 * A cut for `splitClip`, in the **stored** track time that model owns —
 * `splitClipInDraft` measures it against `clip.start`.
 */
export interface SplitPoint {
  clipId: string;
  splitTick: number;
}

export interface ResolveSplitPointsInput extends PlayheadCoverageInput {
  /**
   * When non-empty, only these clips are cut (razor mode is the empty case).
   * Unlike markers there is no fallback: a selection that the playhead misses
   * splits nothing, rather than cutting everything under the playhead.
   */
  selectedClipIds?: readonly string[];
}

/**
 * The clips the playhead is actually drawn over. Single implementation of that
 * question — `getTimelineClipsInPresentationRange` is the store-reading front
 * door onto it.
 *
 * "Under the playhead" is a question about presentation footprints: ripple
 * retiming moves a clip's footprint away from `clip.start`, so a stored-span
 * test (`clip.start <= tick < clip.start + timelineDuration`) answers it for a
 * position the clip no longer occupies on screen.
 */
function collectClipsAtPlayhead(
  mapper: TimelinePlacementMapper,
  clips: readonly TimelineClip[],
  playheadTick: number,
  includeMaskChildren: boolean,
): TimelineClip[] {
  const idsAtPlayhead = new Set(
    mapper.getClipIdsAtPresentationTick(presentationTick(playheadTick)),
  );
  return clips.filter(
    (clip) =>
      idsAtPlayhead.has(clip.id) &&
      (includeMaskChildren || clip.type !== "mask"),
  );
}

export function resolveClipsAtPlayhead({
  tracks,
  clips,
  fps,
  presentationTick: playheadTick,
  includeMaskChildren = false,
}: PlayheadCoverageInput): TimelineClip[] {
  return collectClipsAtPlayhead(
    createTimelinePlacementMapper({ tracks, clips, fps }),
    clips,
    playheadTick,
    includeMaskChildren,
  );
}

/**
 * Resolve the markers a "add marker at playhead" action should write.
 *
 * Both halves have to read presentation time, because a ripple-retiming
 * adjustment moves a clip's on-screen footprint away from its stored `start`:
 *
 *  - which clips the playhead is over is a question about footprints, not
 *    about `clip.start .. clip.start + timelineDuration`;
 *  - the anchor is `presentationTick -> effectiveTrackTick -> source time`,
 *    the same chain keyframes commit through (`presentationToClipSourceTime`),
 *    not `playhead - clip.start` pulled through the clip's own speed stack.
 *
 * Using stored time for either one places the marker off by the ripple shift —
 * or on the wrong clip entirely — while the overlay renders it faithfully at
 * the source time it was told to.
 */
export function resolveMarkerPlacementsAtPlayhead({
  tracks,
  clips,
  fps,
  presentationTick: playheadTick,
  preferredClipIds = [],
}: ResolveMarkerPlacementsInput): MarkerPlacement[] {
  const covered = resolveClipsAtPlayhead({
    tracks,
    clips,
    fps,
    presentationTick: playheadTick,
  });
  const preferred = new Set(preferredClipIds);
  const targets = covered.some((clip) => preferred.has(clip.id))
    ? covered.filter((clip) => preferred.has(clip.id))
    : covered;

  return targets.map((clip) => ({
    clipId: clip.id,
    sourceTimeTicks: presentationToClipSourceTime(
      { tracks, clips, fps },
      clip,
      playheadTick,
    ),
  }));
}

/**
 * Resolve the cuts a "split at playhead" action should make.
 *
 * `splitClipInDraft` speaks stored track time — it bounds-checks against
 * `clip.start` and derives the left duration from it — so the presentation
 * playhead is converted here, at the boundary, rather than handed to the model
 * in the wrong domain. Under a ripple retime the two differ, and passing the
 * raw playhead either trips the model's out-of-bounds guard (a silent no-op) or
 * cuts at the wrong content frame.
 *
 * Cuts that would land on or outside a clip's edges are dropped, matching the
 * model's own guard so no target ever reaches it just to be rejected.
 */
export function resolveSplitPointsAtPlayhead({
  tracks,
  clips,
  fps,
  presentationTick: playheadTick,
  selectedClipIds = [],
}: ResolveSplitPointsInput): SplitPoint[] {
  const mapper = createTimelinePlacementMapper({ tracks, clips, fps });
  const covered = collectClipsAtPlayhead(mapper, clips, playheadTick, false);
  const selected = new Set(selectedClipIds);
  const targets =
    selected.size > 0
      ? covered.filter((clip) => selected.has(clip.id))
      : covered;

  return targets.flatMap((clip) => {
    const storedTick = mapper.mapPresentationTickToStoredTick(
      clip.id,
      presentationTick(playheadTick),
    );
    if (storedTick === null) return [];
    const splitTick = Math.round(storedTick);

    if (
      splitTick <= clip.start ||
      splitTick >= clip.start + clip.timelineDuration
    ) {
      return [];
    }

    return [{ clipId: clip.id, splitTick }];
  });
}
