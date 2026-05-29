import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import {
  deriveActiveAdjustmentGroups,
  type DerivedRenderGroup,
} from "../utils/deriveAdjustmentGroups";
import {
  buildTimelineClipPresentationLookup,
  type TimelineClipPresentationLookup,
} from "../../timeline/utils/clipPresentation";

/**
 * Shared source-of-truth for adjustment-derived visual grouping and
 * presentation lookup. The player/export layers push `(tracks, clips)` once
 * and the renderer/audio/orchestrator consume sibling derived views from
 * the same snapshot.
 *
 * Presentation model: adjustment clips choose per-clip static retiming or
 * ripple retiming. The lookup hides the placement/rebase details so callers
 * never touch the track-time resolver directly.
 */
export class AdjustmentEffectResolver {
  private tracks: readonly TimelineTrack[] = [];
  private clips: readonly TimelineClip[] = [];
  private presentationLookup: TimelineClipPresentationLookup | null = null;

  setAdjustmentSource(
    tracks: readonly TimelineTrack[],
    clips: readonly TimelineClip[],
  ): void {
    this.tracks = tracks;
    this.clips = clips;
    this.presentationLookup = null;
  }

  deriveGroups(currentTick: number): DerivedRenderGroup[] {
    const lookup = this.getPresentationLookup();
    const activationTickByTrack = new Map<string, number>();

    for (const track of this.tracks) {
      if (track.type !== "visual" || !track.isVisible) continue;
      const resolved = lookup.findActiveClipAt(track.id, currentTick);
      if (!resolved) continue;
      activationTickByTrack.set(track.id, resolved.presentationInputTick);
    }

    return deriveActiveAdjustmentGroups(this.tracks, this.clips, currentTick, {
      activationTickByTrack,
    });
  }

  getPresentationLookup(): TimelineClipPresentationLookup {
    if (!this.presentationLookup) {
      this.presentationLookup = buildTimelineClipPresentationLookup(
        this.tracks,
        this.clips,
      );
    }
    return this.presentationLookup;
  }
}
