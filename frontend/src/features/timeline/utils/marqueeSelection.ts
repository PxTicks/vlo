// utils/marqueeSelection.ts
import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import { CLIP_HEIGHT, RULER_HEIGHT, TRACK_HEIGHT } from "../constants";

/** Gap between a track row's top edge and its clip's top edge (px). */
const CLIP_TOP_INSET = (TRACK_HEIGHT - CLIP_HEIGHT) / 2;

/**
 * A marquee in the timeline's content space: horizontal extent in timeline
 * ticks (so it is zoom-independent), vertical extent in content pixels
 * (track rows are a fixed height).
 */
export interface MarqueeBounds {
  startTick: number;
  endTick: number;
  top: number;
  bottom: number;
}

/** A clip's drawn footprint, resolved once when a marquee gesture starts. */
export interface MarqueeClipBox {
  id: string;
  trackIndex: number;
  start: number;
  end: number;
}

export function buildMarqueeClipBoxes(
  clips: readonly TimelineClip[],
  tracks: readonly TimelineTrack[],
  presentationById: ReadonlyMap<string, { start: number; end: number }>,
): MarqueeClipBox[] {
  const trackIndexById = new Map(
    tracks.map((track, index) => [track.id, index]),
  );
  const boxes: MarqueeClipBox[] = [];
  for (const clip of clips) {
    // Masks are drawn inside their parent clip, not as timeline items.
    if (clip.type === "mask") continue;
    const trackIndex = trackIndexById.get(clip.trackId);
    if (trackIndex === undefined) continue;
    const presentation = presentationById.get(clip.id);
    const start = presentation?.start ?? clip.start;
    const end = presentation?.end ?? clip.start + clip.timelineDuration;
    boxes.push({ id: clip.id, trackIndex, start, end });
  }
  return boxes;
}

/**
 * Ids of every clip whose drawn rectangle the marquee touches, ordered
 * left-to-right then top-to-bottom so the earliest clip becomes the primary
 * selection.
 */
export function resolveMarqueeHits(
  bounds: MarqueeBounds,
  boxes: readonly MarqueeClipBox[],
): string[] {
  return boxes
    .filter((box) => {
      // 1. Horizontal: footprints are half-open [start, end)
      if (box.end <= bounds.startTick || box.start >= bounds.endTick) {
        return false;
      }
      // 2. Vertical: the clip sits inset within its track row
      const top = RULER_HEIGHT + box.trackIndex * TRACK_HEIGHT + CLIP_TOP_INSET;
      return bounds.bottom > top && bounds.top < top + CLIP_HEIGHT;
    })
    .sort((a, b) => a.start - b.start || a.trackIndex - b.trackIndex)
    .map((box) => box.id);
}

/**
 * Additive marquees keep the selection the gesture started with (in its
 * original order, so the primary clip is unchanged) and append new hits.
 */
export function mergeMarqueeSelection(
  base: readonly string[],
  hits: readonly string[],
): string[] {
  if (base.length === 0) return [...hits];
  const seen = new Set(base);
  return [...base, ...hits.filter((id) => !seen.has(id))];
}
