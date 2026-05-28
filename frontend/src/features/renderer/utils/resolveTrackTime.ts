import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import {
  applyAdjustmentTimeRemapInverse,
  applyAdjustmentTimeRemap,
  computeAdjustmentPresentationApplications,
  computeAdjustmentTimeApplications,
  type AdjustmentTimeApplication,
} from "./deriveAdjustmentGroups";

export interface TrackTimeResolver {
  /**
   * For a rendered content track at a given presentation tick, return the
   * effective track tick after composing every adjustment-speed remap in the
   * stack above that track.
   */
  resolveEffectiveTrackTick(trackId: string, presentationTick: number): number;

  /**
   * For editor presentation, return the presentation tick where a stored track
   * tick appears after the adjustment-speed stack above that track is inverted.
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
