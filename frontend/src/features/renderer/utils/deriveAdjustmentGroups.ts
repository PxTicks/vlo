import type {
  AdjustmentTimelineClip,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";

/**
 * A single adjustment clip's effective application to a single visual track.
 * One adjustment clip produces one `AdjustmentApplication` per visual track
 * in its reach.
 *
 * `start` / `timelineDuration` mirror the source clip's fields — keyframe
 * sampling in `applyGroupTransforms` is clip-local
 * (`stackTime = currentTick - group.start`).
 */
export interface AdjustmentApplication {
  sourceClipId: string;
  transformations: ClipTransform[];
  /** Full-track-stack index of the adjustment clip's own track. Lower index
   *  = higher in the stack = applied last on the GPU = outermost wrapper. */
  adjustmentTrackPosition: number;
  start: number;
  timelineDuration: number;
}

/**
 * One Pixi container in the orchestrator's nested forest. May reference the
 * same `sourceClipId` as another entry — partial overlaps split a clip's
 * reach across multiple containers (each applying the same transformations).
 *
 * Field names (`start`, `timelineDuration`, `transformations`) match the
 * legacy `TimelineGroup` shape so `applyGroupTransforms` accepts both. The
 * orchestrator hands these directly to the seam.
 */
export interface DerivedRenderGroup {
  /** Stable id used as the orchestrator's container cache key. Encoded as
   *  `<sourceClipId>@<firstTrackIdInRun>` so consecutive ticks with no
   *  topology change reuse the same container instance. */
  id: string;
  sourceClipId: string;
  transformations: ClipTransform[];
  start: number;
  timelineDuration: number;
  /** Visual tracks wrapped by this container, in visual-track order. */
  trackIds: string[];
  /** Nested groups whose reach is a contiguous subset of this group's
   *  `trackIds`. Apply this group's transforms last (it wraps them). */
  children: DerivedRenderGroup[];
}

function isVisualTrack(track: TimelineTrack): boolean {
  return (track.type === undefined || track.type === "visual") && track.isVisible;
}

function isAdjustmentClipActiveAtTick(
  clip: AdjustmentTimelineClip,
  tick: number,
): boolean {
  return tick >= clip.start && tick < clip.start + clip.timelineDuration;
}

/**
 * For each visual track, compute the stack of adjustment applications
 * applied at `currentTick`, ordered innermost-first → outermost-last.
 *
 * "Outermost" = the adjustment clip whose own track sits highest in the
 * stack (= lowest position index = applied last on the GPU = wraps
 * everything below).
 *
 * Depth counts the next N tracks of any type below the adjustment's own
 * track; only visual tracks among those N are included. Non-visual tracks
 * (audio, mask, other adjustment tracks) consume a slot but contribute
 * nothing to the group.
 */
export function computeAdjustmentApplications(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  currentTick: number,
): Map<string, AdjustmentApplication[]> {
  const trackPositionById = new Map<string, number>();
  tracks.forEach((track, index) => {
    trackPositionById.set(track.id, index);
  });

  const applicationsByTrack = new Map<string, AdjustmentApplication[]>();

  for (const clip of clips) {
    if (clip.type !== "adjustment") continue;
    const adjustment = clip as AdjustmentTimelineClip;
    if (!isAdjustmentClipActiveAtTick(adjustment, currentTick)) continue;

    const clipTrackPosition = trackPositionById.get(adjustment.trackId);
    if (clipTrackPosition === undefined) continue; // orphaned

    // Honor the adjustment track's visibility toggle: if the user hides the
    // adjustment track, its clips contribute no transforms. (Hiding the
    // adjustment *track* is a fast A/B compare; the clips themselves
    // remain authored.)
    const adjustmentTrack = tracks[clipTrackPosition];
    if (!adjustmentTrack || adjustmentTrack.isVisible === false) continue;

    if (adjustment.depth < 1) continue;

    // Reach: next `depth` track positions strictly below clip's own track,
    // clamped at the bottom of the stack. Visual tracks among those are
    // included; non-visual tracks consume a slot but contribute nothing.
    const reachStart = clipTrackPosition + 1;
    const reachEnd = Math.min(tracks.length, reachStart + adjustment.depth);

    for (let pos = reachStart; pos < reachEnd; pos += 1) {
      const track = tracks[pos];
      if (!track) continue;
      if (!isVisualTrack(track)) continue;

      const application: AdjustmentApplication = {
        sourceClipId: adjustment.id,
        transformations: adjustment.transformations,
        adjustmentTrackPosition: clipTrackPosition,
        start: adjustment.start,
        timelineDuration: adjustment.timelineDuration,
      };

      const list = applicationsByTrack.get(track.id) ?? [];
      list.push(application);
      applicationsByTrack.set(track.id, list);
    }
  }

  // Sort innermost-first → outermost-last. Outermost = lowest position
  // (topmost adjustment track). So we want descending by position.
  for (const list of applicationsByTrack.values()) {
    list.sort((a, b) => b.adjustmentTrackPosition - a.adjustmentTrackPosition);
  }

  return applicationsByTrack;
}

function makeGroupId(sourceClipId: string, firstTrackId: string): string {
  return `${sourceClipId}@${firstTrackId}`;
}

/**
 * Build the nested-container forest for `currentTick`. Top-level entries are
 * group containers that attach to the orchestrator's root; nested children
 * are wrapped inside their parent.
 *
 * A contiguous run of visual tracks that share the same outermost
 * application gets ONE container at that level; tracks with a deeper
 * application are handled by recursion into the next stack layer. Tracks
 * with no applications at all are not represented here — the orchestrator
 * parents their engine containers directly to root.
 */
export function deriveActiveAdjustmentGroups(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  currentTick: number,
): DerivedRenderGroup[] {
  const applicationsByTrack = computeAdjustmentApplications(
    tracks,
    clips,
    currentTick,
  );

  // Walk visual tracks in project order.
  const visualTracks = tracks.filter(isVisualTrack);

  /**
   * Build the forest at `depth` (0 = outermost). For each contiguous run of
   * tracks sharing the same application at this depth, emit one container
   * and recurse into depth+1 for nested groups.
   *
   * `depth` indexes into the per-track stack from the OUTER end:
   *   - stack is innermost-first, outermost-last
   *   - so the application at depth `d` is `stack[stack.length - 1 - d]`.
   */
  function buildForest(
    tracksSlice: readonly TimelineTrack[],
    depth: number,
  ): DerivedRenderGroup[] {
    const result: DerivedRenderGroup[] = [];
    let i = 0;
    while (i < tracksSlice.length) {
      const stack = applicationsByTrack.get(tracksSlice[i].id) ?? [];
      const appAtDepth = stack[stack.length - 1 - depth];

      if (!appAtDepth) {
        // No wrapper at this level for this track; it's "exposed" inside
        // the parent's container (handled by the orchestrator) or attached
        // directly to root if depth === 0.
        i += 1;
        continue;
      }

      // Run forward while the next track also has this same application
      // at this depth.
      let j = i + 1;
      while (j < tracksSlice.length) {
        const nextStack = applicationsByTrack.get(tracksSlice[j].id) ?? [];
        const nextAppAtDepth = nextStack[nextStack.length - 1 - depth];
        if (!nextAppAtDepth) break;
        if (nextAppAtDepth.sourceClipId !== appAtDepth.sourceClipId) break;
        j += 1;
      }

      const run = tracksSlice.slice(i, j);
      const trackIds = run.map((t) => t.id);
      const children = buildForest(run, depth + 1);

      result.push({
        id: makeGroupId(appAtDepth.sourceClipId, trackIds[0]),
        sourceClipId: appAtDepth.sourceClipId,
        transformations: appAtDepth.transformations,
        start: appAtDepth.start,
        timelineDuration: appAtDepth.timelineDuration,
        trackIds,
        children,
      });

      i = j;
    }
    return result;
  }

  return buildForest(visualTracks, 0);
}
