import type {
  AdjustmentDepth,
  AdjustmentRetimingMode,
  AdjustmentTimelineClip,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import {
  getAdjustmentRetimingMode,
  isAdjustmentDepthAll,
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
 *
 * @remarks
 * Used both by visual-effect grouping (active path) and by the legacy
 * global track-time warp engine in `resolveTrackTime.ts` (kept reachable but
 * not consumed by UI/DnD/renderer directly — see clipPresentation.ts).
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
  /** Source-tick trim into the ramp (mirrors clip.offset). Non-zero after a
   *  left-edge crop. */
  offset: number;
  /** Transformed/presentation-tick trim into the ramp (mirrors
   *  clip.transformedOffset). Non-zero after a left-edge crop. */
  transformedOffset: number;
  retimingMode: AdjustmentRetimingMode;
  /** Absolute tick in this adjustment's input-level domain for this frame.
   *  Present only on active applications derived for a specific render tick. */
  sampleTick?: number;
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
  /** Absolute tick in the adjustment's input-level domain for this frame. */
  sampleTick?: number;
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
    offset: adjustment.offset,
    transformedOffset: adjustment.transformedOffset,
    retimingMode: getAdjustmentRetimingMode(adjustment),
  };
}

function resolveAdjustmentReachEnd(
  depth: AdjustmentDepth,
  trackCount: number,
  reachStart: number,
): number {
  if (isAdjustmentDepthAll(depth)) {
    return trackCount;
  }
  return Math.min(trackCount, reachStart + depth);
}

/**
 * @internal — engine for clipPresentation; not for direct consumption.
 *
 * Apply an adjustment clip's time remap at `tick`, where `tick` is expressed
 * in the clip's input-level domain.
 *
 * Before the clip window the remap is identity. Inside the window it reuses
 * the same backward speed pass as per-clip speed. After the window the full
 * accumulated delta is carried forward so descendants never jump backward at
 * the clip boundary — this carry-forward is what produces the *global*
 * track-time shift that the per-clip presentation model rebases away.
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

  // The window is a crop into the ramp: presentation-space `localOffset` is
  // measured from `transformedOffset`, and the consumed source content is the
  // span the ramp covers from the window start to that point. With no left
  // crop (`transformedOffset === 0`) this reduces to `pull(localOffset)`.
  const windowSourceStart = pullTimeThroughTransforms(
    application.transformations,
    application.transformedOffset,
  );
  const sourceOffset =
    pullTimeThroughTransforms(
      application.transformations,
      application.transformedOffset + localOffset,
    ) - windowSourceStart;
  return application.start + sourceOffset;
}

/**
 * @internal — engine for clipPresentation; not for direct consumption.
 *
 * Inverse of `applyAdjustmentTimeRemap`. Composes with itself across a stack
 * to recover the presentation tick that a stored track tick maps from.
 */
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

  // Inverse of the cropped forward map: source-space `localOffset` is measured
  // from the window's source start; push the absolute source position back to
  // presentation space and rebase by `transformedOffset`. With no left crop
  // (`transformedOffset === 0`) this reduces to `push(localOffset)`.
  const windowSourceStart = pullTimeThroughTransforms(
    application.transformations,
    application.transformedOffset,
  );
  const presentationOffset =
    pushTimeThroughTransforms(
      application.transformations,
      windowSourceStart + localOffset,
    ) - application.transformedOffset;
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
    if (!isAdjustmentDepthAll(adjustment.depth) && adjustment.depth < 1) {
      continue;
    }

    const application = buildApplication(adjustment, clipTrackPosition);
    const reachStart = clipTrackPosition + 1;
    const reachEnd = resolveAdjustmentReachEnd(
      adjustment.depth,
      tracks.length,
      reachStart,
    );

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
      active.push({ ...application, sampleTick: inputTick });
    }

    inputTick = applyAdjustmentTimeRemap(application, inputTick);
  }

  return active;
}

export interface ComputeAdjustmentApplicationsOptions {
  /**
   * Per-track presentation tick after the active clip's placement/rebase has
   * been resolved. Visual grouping uses this to decide whether an adjustment's
   * visual transforms are active for that track.
   */
  activationTickByTrack?: ReadonlyMap<string, number>;
}

export interface ComputeAdjustmentTimeApplicationsOptions {
  retimingModes?: ReadonlySet<AdjustmentRetimingMode>;
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
  options: ComputeAdjustmentApplicationsOptions = {},
): Map<string, AdjustmentApplication[]> {
  const allApplicationsByTrack = buildApplicationsByTrack(
    tracks,
    clips,
    isVisibleVisualTrack,
    () => true,
  );
  const activeApplicationsByTrack = new Map<string, AdjustmentApplication[]>();

  for (const [trackId, applications] of allApplicationsByTrack) {
    const activationTick =
      options.activationTickByTrack?.get(trackId) ?? currentTick;
    const active = resolveActiveApplications(applications, activationTick);
    if (active.length === 0) continue;
    activeApplicationsByTrack.set(trackId, [...active].reverse());
  }

  return activeApplicationsByTrack;
}

/**
 * @internal — engine for clipPresentation; not for direct consumption.
 *
 * For each visual/audio track, compute the full stack of descendant
 * adjustment speed applications, ordered innermost-first → outermost-last.
 *
 * The resolver consumes the requested retiming stack and evaluates activation
 * at lookup time, carrying every outer post-window delta forward into inner
 * activation checks by function composition.
 */
export function computeAdjustmentTimeApplications(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  options: ComputeAdjustmentTimeApplicationsOptions = {},
): Map<string, AdjustmentTimeApplication[]> {
  const applicationsByTrack = buildApplicationsByTrack(
    tracks,
    clips,
    isTimeAffectedTrack,
    (adjustment) =>
      hasEnabledSpeedTransform(adjustment.transformations) &&
      (options.retimingModes === undefined ||
        options.retimingModes.has(getAdjustmentRetimingMode(adjustment))),
  );
  const timeApplicationsByTrack = new Map<string, AdjustmentTimeApplication[]>();

  for (const [trackId, applications] of applicationsByTrack) {
    if (applications.length === 0) continue;
    timeApplicationsByTrack.set(trackId, [...applications].reverse());
  }

  return timeApplicationsByTrack;
}

/**
 * @internal — engine for clipPresentation; not for direct consumption.
 *
 * Sibling of `computeAdjustmentTimeApplications` that also includes
 * adjustment tracks as reachable presentation targets (so adjustment clips
 * themselves can be presentation-mapped by the global-warp engine).
 */
export function computeAdjustmentPresentationApplications(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  options: ComputeAdjustmentTimeApplicationsOptions = {},
): Map<string, AdjustmentTimeApplication[]> {
  const applicationsByTrack = buildApplicationsByTrack(
    tracks,
    clips,
    isPresentationAffectedTrack,
    (adjustment) =>
      hasEnabledSpeedTransform(adjustment.transformations) &&
      (options.retimingModes === undefined ||
        options.retimingModes.has(getAdjustmentRetimingMode(adjustment))),
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
  options: ComputeAdjustmentApplicationsOptions = {},
): DerivedRenderGroup[] {
  const applicationsByTrack = computeAdjustmentApplications(
    tracks,
    clips,
    currentTick,
    options,
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
        if (!canShareRenderGroup(appAtDepth, nextAppAtDepth)) break;
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
        sampleTick: appAtDepth.sampleTick,
        trackIds,
        children,
      });

      i = j;
    }

    return result;
  }

  return buildForest(visualTracks, 0);
}

function canShareRenderGroup(
  left: AdjustmentApplication,
  right: AdjustmentApplication,
): boolean {
  if (left.sourceClipId !== right.sourceClipId) return false;
  if (left.sampleTick === undefined || right.sampleTick === undefined) {
    return left.sampleTick === right.sampleTick;
  }
  return Math.abs(left.sampleTick - right.sampleTick) < 1e-6;
}
