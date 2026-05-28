import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import {
  deriveActiveAdjustmentGroups,
  type DerivedRenderGroup,
} from "../utils/deriveAdjustmentGroups";
import {
  buildTrackTimeResolver,
  type TrackTimeResolver,
} from "../utils/resolveTrackTime";

/**
 * Shared source-of-truth for adjustment-derived visual grouping and
 * time-warping. The player/export layers push `(tracks, clips)` once and the
 * renderer/audio/orchestrator consume sibling derived views from the same
 * snapshot.
 */
export class AdjustmentEffectResolver {
  private tracks: readonly TimelineTrack[] = [];
  private clips: readonly TimelineClip[] = [];
  private timeResolver: TrackTimeResolver | null = null;

  setAdjustmentSource(
    tracks: readonly TimelineTrack[],
    clips: readonly TimelineClip[],
  ): void {
    this.tracks = tracks;
    this.clips = clips;
    this.timeResolver = null;
  }

  deriveGroups(currentTick: number): DerivedRenderGroup[] {
    return deriveActiveAdjustmentGroups(this.tracks, this.clips, currentTick);
  }

  getTimeResolver(): TrackTimeResolver {
    if (!this.timeResolver) {
      this.timeResolver = buildTrackTimeResolver(this.tracks, this.clips);
    }
    return this.timeResolver;
  }
}
