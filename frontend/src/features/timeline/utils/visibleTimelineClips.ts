import type { TimelineClip } from "../../../types/TimelineTypes";
import { pxToTicks } from "../../../core/time/pixelGrid";
import { TRACK_HEADER_WIDTH } from "../constants";
import type { TimelineClipPresentation } from "../time/index";

export interface VisibleTickRange {
  start: number;
  end: number;
}

export interface VisiblePixelWindow {
  start: number;
  end: number;
  contentWidth: number;
}

interface IndexedClip {
  clip: TimelineClip;
  start: number;
  end: number;
  order: number;
  maximumEnd: number;
}

export interface VisibleTimelineClipIndex {
  byTrack: ReadonlyMap<string, readonly IndexedClip[]>;
  byId: ReadonlyMap<string, IndexedClip>;
}

const FALLBACK_VIEWPORT_WIDTH_PX = 1000;

/** Keep a viewport of overscan and shift only near an edge of that buffer. */
export function visiblePixelWindowForViewport(
  scrollLeft: number,
  viewportWidth: number,
  previous: VisiblePixelWindow | null,
): VisiblePixelWindow {
  // A detached or unmeasured viewport still mounts a bounded first window.
  const contentWidth = Math.max(
    1,
    (viewportWidth > 0 ? viewportWidth : FALLBACK_VIEWPORT_WIDTH_PX) -
      TRACK_HEADER_WIDTH,
  );
  const left = Math.max(0, scrollLeft);
  const margin = contentWidth / 4;
  if (
    previous?.contentWidth === contentWidth &&
    (previous.start === 0 || left >= previous.start + margin) &&
    left + contentWidth <= previous.end - margin
  ) {
    return previous;
  }

  return {
    start: Math.max(0, left - contentWidth),
    end: left + 2 * contentWidth,
    contentWidth,
  };
}

export function visibleTickRangeForPixelWindow(
  window: VisiblePixelWindow | null,
  zoomScale: number,
): VisibleTickRange {
  if (!window) return { start: 0, end: 0 };
  return {
    start: Math.max(0, Math.floor(pxToTicks(window.start, zoomScale))),
    end: Math.ceil(pxToTicks(window.end, zoomScale)),
  };
}

/** Build once per clip/presentation snapshot; prefix ends preserve long overlaps. */
export function buildVisibleTimelineClipIndex(
  clips: readonly TimelineClip[],
  presentationById: ReadonlyMap<string, TimelineClipPresentation>,
): VisibleTimelineClipIndex {
  const byTrack = new Map<string, IndexedClip[]>();
  const byId = new Map<string, IndexedClip>();

  clips.forEach((clip, order) => {
    const presentation = presentationById.get(clip.id);
    const entry: IndexedClip = {
      clip,
      start: presentation?.start ?? clip.start,
      end: presentation?.end ?? clip.start + clip.timelineDuration,
      order,
      maximumEnd: 0,
    };
    const track = byTrack.get(clip.trackId) ?? [];
    track.push(entry);
    byTrack.set(clip.trackId, track);
    byId.set(clip.id, entry);
  });

  for (const track of byTrack.values()) {
    track.sort((left, right) => left.start - right.start || left.order - right.order);
    let maximumEnd = -Infinity;
    for (const entry of track) {
      maximumEnd = Math.max(maximumEnd, entry.end);
      entry.maximumEnd = maximumEnd;
    }
  }

  return { byTrack, byId };
}

export function clipsInVisibleTimelineRange(
  index: VisibleTimelineClipIndex,
  range: VisibleTickRange,
  pinnedClipIds: Iterable<string>,
): TimelineClip[] {
  const visible = new Map<string, IndexedClip>();

  for (const track of index.byTrack.values()) {
    // The prefix maximum lets us skip clips ending before the left boundary,
    // while retaining a long clip that began before this viewport.
    let low = 0;
    let high = track.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (track[middle].maximumEnd <= range.start) low = middle + 1;
      else high = middle;
    }
    for (let position = low; position < track.length; position += 1) {
      const entry = track[position];
      if (entry.start >= range.end) break;
      if (entry.end > range.start) visible.set(entry.clip.id, entry);
    }
  }

  for (const id of pinnedClipIds) {
    const entry = index.byId.get(id);
    if (entry) visible.set(id, entry);
  }

  return [...visible.values()]
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.clip);
}
