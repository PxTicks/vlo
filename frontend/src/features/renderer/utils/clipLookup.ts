import type { TimelineClip } from "../../../types/TimelineTypes";
import type { TimelineClipPresentationLookup } from "../../timeline/time/index";

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
  presentationStart: number;
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
  const lookup = resolver.getPresentationLookup();
  const found = lookup.findActiveClipAt(trackId, presentationTick);
  if (!found) return null;
  const liveClip = trackClips.find((clip) => clip.id === found.clipId);
  if (!liveClip) return null;
  const getPresentationStart = (
    lookup as TimelineClipPresentationLookup & {
      getPresentationStart?: (clipId: string) => number | null;
    }
  ).getPresentationStart;
  return {
    clip: liveClip,
    effectiveTick: found.effectiveTick,
    presentationStart:
      (typeof getPresentationStart === "function"
        ? getPresentationStart.call(lookup, found.clipId)
        : null) ??
      liveClip.start,
  };
}

/**
 * Resolve the clip playing on a track at a presentation tick, as audio
 * playback sees it: through the presentation lookup when a resolver is wired,
 * falling back to raw placement only for clips the lookup has not placed.
 */
export function findActiveClipAtPresentation(
  resolver: PresentationLookupProvider | null,
  trackId: string,
  trackClips: readonly TimelineClip[],
  presentationTick: number,
): { clip: TimelineClip; effectiveTick: number } | null {
  if (resolver && trackId) {
    const resolved = resolveLiveActiveClip(
      resolver,
      trackId,
      trackClips,
      presentationTick,
    );
    if (resolved) {
      return { clip: resolved.clip, effectiveTick: resolved.effectiveTick };
    }
  }

  // No resolver, or an audio-only composite that expanded into synthetic lane
  // clips not present in the adjustment lookup. They already carry parent
  // timing, so scan the supplied lane directly as a fallback.
  //
  // Only for those clips. A clip the lookup has placed was just reported
  // inactive here, and its raw placement is not where it plays: after a
  // ripple retime shortens the timeline, raw placement outlasts the
  // presented footprint, and treating the clip as active there asks its
  // source for time past its end.
  const lookup = resolver?.getPresentationLookup();
  for (const candidate of trackClips) {
    if (lookup?.getPresentation(candidate.id)) continue;
    const clipEnd = candidate.start + candidate.timelineDuration;
    if (candidate.start <= presentationTick && presentationTick < clipEnd) {
      return { clip: candidate, effectiveTick: presentationTick };
    }
  }
  return null;
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
