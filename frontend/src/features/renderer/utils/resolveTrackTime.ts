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
} from "./deriveAdjustmentGroups";

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
}

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

  return {
    resolveEffectiveTrackTick(trackId, presentationTick) {
      const stack = timeApplicationsByTrack.get(trackId) ?? [];
      if (stack.length === 0) {
        return presentationTick;
      }
      return resolveStackTick(stack, presentationTick);
    },
    resolvePresentationTick(trackId, effectiveTrackTick) {
      const stack = presentationApplicationsByTrack.get(trackId) ?? [];
      if (stack.length === 0) {
        return effectiveTrackTick;
      }
      return resolveStackPresentationTick(stack, effectiveTrackTick);
    },
  };
}
