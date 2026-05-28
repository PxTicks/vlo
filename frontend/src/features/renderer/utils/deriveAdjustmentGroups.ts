import type {
  AdjustmentTimelineClip,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import {
  pullTimeThroughTransforms,
  pushTimeThroughTransforms,
} from "../../transformations/utils/timeCalculation";

/**
 * A single adjustment clip's effective application to a single descendant
 * track. One adjustment clip produces one application per reached track.
 *
 * `start` / `timelineDuration` live in the adjustment clip's own input-level
 * time domain. Inner adjustments evaluate their activation window against the
 * tick after every outer remap has been applied.
 */
export interface AdjustmentApplication {
  sourceClipId: string;
  transformations: ClipTransform[];
  /** Full-track-stack index of the adjustment clip's own track. Lower index
   *  = higher in the stack = applied last on the GPU = outermost wrapper. */
  adjustmentTrackPosition: number;
  start: number;
  timelineDuration: number;
  sourceDuration: number;
}

export type AdjustmentTimeApplication = AdjustmentApplication;

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

function isVisibleVisualTrack(track: TimelineTrack): boolean {
  return track.type === "visual" && track.isVisible;
}

function isTimeAffectedTrack(track: TimelineTrack): boolean {
  return (
    (track.type === "visual" || track.type === "audio") &&
    track.isVisible
  );
}

function isPresentationAffectedTrack(track: TimelineTrack): boolean {
  return (
    track.type === "visual" ||
    track.type === "audio" ||
    track.type === "adjustment"
  );
}

export function hasEnabledSpeedTransform(
  transformations: readonly ClipTransform[],
): boolean {
  return transformations.some(
    (transform) => transform.isEnabled && transform.type === "speed",
  );
}

function buildApplication(
  adjustment: AdjustmentTimelineClip,
  adjustmentTrackPosition: number,
): AdjustmentApplication {
  return {
    sourceClipId: adjustment.id,
    transformations: adjustment.transformations,
    adjustmentTrackPosition,
    start: adjustment.start,
    timelineDuration: adjustment.timelineDuration,
    sourceDuration: adjustment.sourceDuration,
  };
}

/**
 * Apply an adjustment clip's time remap at `tick`, where `tick` is expressed
 * in the clip's input-level domain.
 *
 * Before the clip window the remap is identity. Inside the window it reuses
 * the same backward speed pass as per-clip speed. After the window the full
 * accumulated delta is carried forward so descendants never jump backward at
 * the clip boundary.
 */
export function applyAdjustmentTimeRemap(
  application: AdjustmentTimeApplication,
  tick: number,
): number {
  if (tick < application.start) {
    return tick;
  }

  const localOffset = tick - application.start;
  if (localOffset >= application.timelineDuration) {
    return tick + (application.sourceDuration - application.timelineDuration);
  }

  const sourceOffset = pullTimeThroughTransforms(
    application.transformations,
    localOffset,
  );
  return application.start + sourceOffset;
}

export function applyAdjustmentTimeRemapInverse(
  application: AdjustmentTimeApplication,
  tick: number,
): number {
  if (tick < application.start) {
    return tick;
  }

  const localOffset = tick - application.start;
  if (localOffset >= application.sourceDuration) {
    return tick - (application.sourceDuration - application.timelineDuration);
  }

  const presentationOffset = pushTimeThroughTransforms(
    application.transformations,
    localOffset,
  );
  return application.start + presentationOffset;
}

function buildApplicationsByTrack(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  shouldIncludeTrack: (track: TimelineTrack) => boolean,
  shouldIncludeAdjustment: (adjustment: AdjustmentTimelineClip) => boolean,
): Map<string, AdjustmentApplication[]> {
  const trackPositionById = new Map<string, number>();
  tracks.forEach((track, index) => {
    trackPositionById.set(track.id, index);
  });

  const applicationsByTrack = new Map<string, AdjustmentApplication[]>();

  for (const clip of clips) {
    if (clip.type !== "adjustment") continue;
    const adjustment = clip as AdjustmentTimelineClip;
    if (adjustment.isMuted === true) continue;
    if (!shouldIncludeAdjustment(adjustment)) continue;

    const clipTrackPosition = trackPositionById.get(adjustment.trackId);
    if (clipTrackPosition === undefined) continue;

    const adjustmentTrack = tracks[clipTrackPosition];
    if (!adjustmentTrack || adjustmentTrack.isVisible === false) continue;
    if (adjustment.depth < 1) continue;

    const application = buildApplication(adjustment, clipTrackPosition);
    const reachStart = clipTrackPosition + 1;
    const reachEnd = Math.min(tracks.length, reachStart + adjustment.depth);

    for (let pos = reachStart; pos < reachEnd; pos += 1) {
      const track = tracks[pos];
      if (!track || !shouldIncludeTrack(track)) continue;

      const list = applicationsByTrack.get(track.id) ?? [];
      list.push(application);
      applicationsByTrack.set(track.id, list);
    }
  }

  // Outermost-first: lowest position index sits highest in the stack.
  for (const list of applicationsByTrack.values()) {
    list.sort(
      (left, right) =>
        left.adjustmentTrackPosition - right.adjustmentTrackPosition,
    );
  }

  return applicationsByTrack;
}

function resolveActiveApplications(
  applications: readonly AdjustmentApplication[],
  presentationTick: number,
): AdjustmentApplication[] {
  const active: AdjustmentApplication[] = [];
  let inputTick = presentationTick;

  for (const application of applications) {
    const isActive =
      inputTick >= application.start &&
      inputTick < application.start + application.timelineDuration;

    if (isActive) {
      active.push(application);
    }

    inputTick = applyAdjustmentTimeRemap(application, inputTick);
  }

  return active;
}

/**
 * For each visual track, compute the active stack of adjustment applications
 * applied at `currentTick`, ordered innermost-first → outermost-last.
 *
 * Inner activation is evaluated in the outer-warped input domain so nested
 * adjustment filters/layout stay aligned with the same content the time
 * resolver warps underneath them.
 */
export function computeAdjustmentApplications(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  currentTick: number,
): Map<string, AdjustmentApplication[]> {
  const allApplicationsByTrack = buildApplicationsByTrack(
    tracks,
    clips,
    isVisibleVisualTrack,
    () => true,
  );
  const activeApplicationsByTrack = new Map<string, AdjustmentApplication[]>();

  for (const [trackId, applications] of allApplicationsByTrack) {
    const active = resolveActiveApplications(applications, currentTick);
    if (active.length === 0) continue;
    activeApplicationsByTrack.set(trackId, [...active].reverse());
  }

  return activeApplicationsByTrack;
}

/**
 * For each visual/audio track, compute the full stack of descendant
 * adjustment speed applications, ordered innermost-first → outermost-last.
 *
 * The resolver consumes the full static stack and evaluates activation at
 * lookup time, carrying every outer post-window delta forward into inner
 * activation checks by function composition.
 */
export function computeAdjustmentTimeApplications(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
): Map<string, AdjustmentTimeApplication[]> {
  const applicationsByTrack = buildApplicationsByTrack(
    tracks,
    clips,
    isTimeAffectedTrack,
    (adjustment) => hasEnabledSpeedTransform(adjustment.transformations),
  );
  const timeApplicationsByTrack = new Map<string, AdjustmentTimeApplication[]>();

  for (const [trackId, applications] of applicationsByTrack) {
    if (applications.length === 0) continue;
    timeApplicationsByTrack.set(trackId, [...applications].reverse());
  }

  return timeApplicationsByTrack;
}

export function computeAdjustmentPresentationApplications(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
): Map<string, AdjustmentTimeApplication[]> {
  const applicationsByTrack = buildApplicationsByTrack(
    tracks,
    clips,
    isPresentationAffectedTrack,
    (adjustment) => hasEnabledSpeedTransform(adjustment.transformations),
  );
  const presentationApplicationsByTrack = new Map<
    string,
    AdjustmentTimeApplication[]
  >();

  for (const [trackId, applications] of applicationsByTrack) {
    if (applications.length === 0) continue;
    presentationApplicationsByTrack.set(trackId, [...applications].reverse());
  }

  return presentationApplicationsByTrack;
}

function makeGroupId(sourceClipId: string, firstTrackId: string): string {
  return `${sourceClipId}@${firstTrackId}`;
}

/**
 * Build the nested-container forest for `currentTick`. Top-level entries are
 * group containers that attach to the orchestrator's root; nested children
 * are wrapped inside their parent.
 *
 * A contiguous run of visual tracks that share the same outermost active
 * application gets one container at that level; tracks with a deeper active
 * application are handled by recursion into the next stack layer. Tracks with
 * no active applications at all are not represented here — the orchestrator
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

  const visualTracks = tracks.filter(isVisibleVisualTrack);

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
        i += 1;
        continue;
      }

      let j = i + 1;
      while (j < tracksSlice.length) {
        const nextStack = applicationsByTrack.get(tracksSlice[j].id) ?? [];
        const nextAppAtDepth = nextStack[nextStack.length - 1 - depth];
        if (!nextAppAtDepth) break;
        if (nextAppAtDepth.sourceClipId !== appAtDepth.sourceClipId) break;
        j += 1;
      }

      const run = tracksSlice.slice(i, j);
      const trackIds = run.map((track) => track.id);
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
