import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import {
  applyAdjustmentTimeRemap,
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

export function buildTrackTimeResolver(
  tracks: readonly TimelineTrack[],
  clips: readonly TimelineClip[],
): TrackTimeResolver {
  const applicationsByTrack = computeAdjustmentTimeApplications(tracks, clips);

  return {
    resolveEffectiveTrackTick(trackId, presentationTick) {
      const stack = applicationsByTrack.get(trackId) ?? [];
      if (stack.length === 0) {
        return presentationTick;
      }
      return resolveStackTick(stack, presentationTick);
    },
  };
}
