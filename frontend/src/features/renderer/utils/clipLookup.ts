import type { TimelineClip } from "../../../types/TimelineTypes";
import type { TimelineClipPresentationLookup } from "../../timeline/utils/clipPresentation";

export function sortTrackClipsByStart(trackClips: TimelineClip[]): TimelineClip[] {
  if (trackClips.length <= 1) return trackClips;
  return [...trackClips].sort(
    (left, right) => left.start - right.start || left.id.localeCompare(right.id),
  );
}

/** Structural view of `AdjustmentEffectResolver` — only the lookup accessor,
 *  so this leaf util doesn't depend on the renderer services layer. */
export interface PresentationLookupProvider {
  getPresentationLookup(): TimelineClipPresentationLookup;
}

export interface ActiveClipResolution {
  clip: TimelineClip;
  effectiveTick: number;
}

/**
 * Resolve the active clip at a presentation tick through the adjustment
 * presentation lookup, then re-bind to the **live** `trackClips` by id so the
 * returned clip always carries current data.
 *
 * This is the single bridge for the clip-resolution principle: the lookup owns
 * identity + timing ("which clip, and when"); its entries are a snapshot
 * invalidated on a React effect, so clip *data* must come from the live array.
 * Reading clip data straight off the lookup serves stale values — that was the
 * cause of committed transform/blur edits visibly reverting. Returns `null`
 * when the lookup finds no clip, or when the resolved id is not present in the
 * live `trackClips` (e.g. it was just deleted, or it is a synthetic lane clip
 * the caller must handle separately).
 */
export function resolveLiveActiveClip(
  resolver: PresentationLookupProvider,
  trackId: string,
  trackClips: readonly TimelineClip[],
  presentationTick: number,
): ActiveClipResolution | null {
  const found = resolver
    .getPresentationLookup()
    .findActiveClipAt(trackId, presentationTick);
  if (!found) return null;
  const liveClip = trackClips.find((clip) => clip.id === found.clipId);
  if (!liveClip) return null;
  return { clip: liveClip, effectiveTick: found.effectiveTick };
}

/**
 * Finds the active clip at `targetTicks`.
 * Expects clips sorted by `start` in ascending order.
 */
export function findActiveClipAtTicks(
  trackClips: readonly TimelineClip[],
  targetTicks: number,
): TimelineClip | undefined {
  const searchableClips = trackClips.some((clip) => clip.type === "mask")
    ? trackClips.filter((clip) => clip.type !== "mask")
    : trackClips;

  let low = 0;
  let high = searchableClips.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const clip = searchableClips[mid];
    const clipEnd = clip.start + clip.timelineDuration;

    if (targetTicks < clip.start) {
      high = mid - 1;
      continue;
    }
    if (targetTicks >= clipEnd) {
      low = mid + 1;
      continue;
    }
    return clip;
  }

  return undefined;
}
