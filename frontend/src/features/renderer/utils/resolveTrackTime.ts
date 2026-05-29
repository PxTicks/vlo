import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
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
 * Implements the *global track-time warp* adjustment model: a 2x speed
 * adjustment compresses the entire track's time below it, shifting every
 * downstream clip to the left (even ones not under the adjustment). This
 * model gives a single coherent warped time axis per track and handles
 * spline-shaped speed transforms exactly via pullTimeThroughTransforms.
 *
 * The active presentation model (clipPresentation.ts) instead compresses
 * *only* clips that intersect an adjustment and pins every clip's
 * presentation_start to its stored start (no global shift). That module
 * composes this resolver under a per-clip rebase so the within-clip
 * compression math — including splines — is reused without duplication.
 *
 * Do not consume this resolver from UI / DnD / renderer code; route those
 * through the presentation index. Kept reachable so the global-warp model
 * can be revived as the active presentation later if desired.
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
): TrackTimeResolver {
  const timeApplicationsByTrack = computeAdjustmentTimeApplications(
    tracks,
    clips,
  );
  const presentationApplicationsByTrack =
    computeAdjustmentPresentationApplications(tracks, clips);

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
