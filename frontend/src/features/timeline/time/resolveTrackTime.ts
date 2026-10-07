import type {
  AdjustmentRetimingMode,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import {
  applyAdjustmentTimeRemapInverse,
  applyAdjustmentTimeRemap,
  computeAdjustmentPresentationApplications,
  computeAdjustmentTimeApplications,
  type AdjustmentTimeApplication,
} from "../../renderer/utils/deriveAdjustmentGroups";
import { getSpeedMappingRevision } from "../../transformations/utils/timeCalculation";

/**
 * @internal — engine for clipPresentation; not for direct consumption.
 *
 * Implements the track-time warp used by adjustment speed transforms. By
 * default it includes both retiming modes; callers can pass `retimingModes`
 * when they need only the ripple/layout subset.
 *
 * clipPresentation.ts composes this resolver twice: ripple adjustments pick
 * the on-screen placement, while static adjustments are locally rebased so
 * they retime covered clip content without shifting later clips.
 *
 * Do not consume this resolver from UI / DnD / renderer code; route those
 * through the presentation index.
 */
export interface TrackTimeResolver {
  /**
   * For the player/audio engine, return the stored-track tick that should
   * play at `presentationTick` after walking the adjustment-speed
   * application stack above that track.
   */
  resolveEffectiveTrackTick(trackId: string, presentationTick: number): number;

  /**
   * Inverse of `resolveEffectiveTrackTick`: return the presentation tick at
   * which a given stored-track tick appears in the warped axis.
   */
  resolvePresentationTick(trackId: string, effectiveTrackTick: number): number;

  /**
   * The same warp bound to one track. It holds only that track's stacks, so a
   * presentation entry that keeps it does not retain the whole snapshot.
   */
  forTrack(trackId: string): TrackTimeWarp;
}

export interface TrackTimeWarp {
  /**
   * The stacks' values and the speed-provider revision, captured when the warp
   * is built. The warp maps over its own copy of those values, so equal
   * signatures map every tick identically for the life of both warps.
   */
  readonly signature: string;
  resolveEffectiveTrackTick(presentationTick: number): number;
  resolvePresentationTick(effectiveTrackTick: number): number;
}

const EMPTY_STACK: readonly AdjustmentTimeApplication[] = [];

export interface BuildTrackTimeResolverOptions {
  retimingModes?: readonly AdjustmentRetimingMode[];
}

function resolveStackTick(
  stack: readonly AdjustmentTimeApplication[],
  presentationTick: number,
): number {
  let tick = presentationTick;

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    tick = applyAdjustmentTimeRemap(stack[index], tick);
  }

  return tick;
}

function resolveStackPresentationTick(
  stack: readonly AdjustmentTimeApplication[],
  effectiveTrackTick: number,
): number {
  let tick = effectiveTrackTick;

  for (let index = 0; index < stack.length; index += 1) {
    tick = applyAdjustmentTimeRemapInverse(stack[index], tick);
  }

  return tick;
}

export function buildTrackTimeResolver(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
  options: BuildTrackTimeResolverOptions = {},
): TrackTimeResolver {
  const retimingModes =
    options.retimingModes === undefined
      ? undefined
      : new Set(options.retimingModes);
  const timeApplicationsByTrack = computeAdjustmentTimeApplications(
    tracks,
    clips,
    { retimingModes },
  );
  const presentationApplicationsByTrack =
    computeAdjustmentPresentationApplications(tracks, clips, {
      retimingModes,
    });

  const warps = new Map<string, TrackTimeWarp>();
  const forTrack = (trackId: string): TrackTimeWarp => {
    let warp = warps.get(trackId);
    if (!warp) {
      let timeStack = timeApplicationsByTrack.get(trackId) ?? EMPTY_STACK;
      let presentationStack =
        presentationApplicationsByTrack.get(trackId) ?? EMPTY_STACK;
      let signature = "";
      if (timeStack.length > 0 || presentationStack.length > 0) {
        // Copy, so a later in-place edit to a clip's transformations can't
        // change what this warp maps while its signature stays the same.
        [timeStack, presentationStack] = structuredClone([
          timeStack,
          presentationStack,
        ]);
        signature = `${getSpeedMappingRevision()}|${JSON.stringify(
          [timeStack, presentationStack],
          exactNumbers,
        )}`;
      }
      warp = {
        signature,
        resolveEffectiveTrackTick: (presentationTick) =>
          timeStack.length === 0
            ? presentationTick
            : resolveStackTick(timeStack, presentationTick),
        resolvePresentationTick: (effectiveTrackTick) =>
          presentationStack.length === 0
            ? effectiveTrackTick
            : resolveStackPresentationTick(presentationStack, effectiveTrackTick),
      };
      warps.set(trackId, warp);
    }
    return warp;
  };

  return {
    resolveEffectiveTrackTick(trackId, presentationTick) {
      return forTrack(trackId).resolveEffectiveTrackTick(presentationTick);
    },
    resolvePresentationTick(trackId, effectiveTrackTick) {
      return forTrack(trackId).resolvePresentationTick(effectiveTrackTick);
    },
    forTrack,
  };
}

// JSON writes NaN and the infinities as null and -0 as 0; keep them distinct.
function exactNumbers(_key: string, value: unknown): unknown {
  return typeof value === "number" &&
    (!Number.isFinite(value) || Object.is(value, -0))
    ? { number: Object.is(value, -0) ? "-0" : String(value) }
    : value;
}

/** Whether two warps map every tick identically. */
export function trackTimeWarpsEqual(
  left: TrackTimeWarp,
  right: TrackTimeWarp,
): boolean {
  return left === right || left.signature === right.signature;
}
