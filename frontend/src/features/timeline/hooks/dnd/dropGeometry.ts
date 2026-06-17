import {
  RULER_HEIGHT,
  SNAP_THRESHOLD_PX,
  TRACK_HEADER_WIDTH,
  TRACK_HEIGHT,
} from "../../constants";
import { GHOST_CLIP_HEIGHT, getGhostClipPosition } from "./dragGeometry";
import { getMoveSnapCandidate } from "./snapUtils";

/**
 * Shared, pure geometry for resolving where a drag lands on the timeline.
 *
 * Both the asset/clip move flow (`useClipMove`) and the transform-card drop
 * flow consume these helpers so the on-screen ghost and the computed drop
 * point are derived from the same numbers. Everything here is a pure function
 * of its inputs — no store reads, no DOM beyond constructing a result — so it
 * can be unit-tested in isolation.
 */

/** Top/bottom fraction of a track row that triggers an interstitial insert. */
export const INTERSTITIAL_ZONE_RATIO = 0.35;

/**
 * Convert the dragged ghost's left edge (viewport px) to a timeline start tick.
 * Mirrors the inline math in `useClipMove` (subtract the header, add scroll).
 */
export function getTickFromDragLeft(
  dragLeftPx: number,
  containerLeftPx: number,
  scrollLeft: number,
  pxToTicks: (px: number) => number,
): number {
  const relativeX = dragLeftPx - containerLeftPx + scrollLeft - TRACK_HEADER_WIDTH;
  return Math.max(0, pxToTicks(relativeX));
}

/**
 * Resolve the track index under a viewport Y coordinate, or -1 when the
 * coordinate is above the first track / below the last / outside the
 * container. Mirrors the coordinate-fallback math in `useClipMove`.
 */
export function getTrackIndexAtY(
  cursorY: number,
  containerTopPx: number,
  containerBottomPx: number,
  scrollTop: number,
  trackCount: number,
): number {
  if (cursorY < containerTopPx || cursorY > containerBottomPx) {
    return -1;
  }
  const relativeY = cursorY - containerTopPx + scrollTop - RULER_HEIGHT;
  if (relativeY < 0) {
    return -1;
  }
  const index = Math.floor(relativeY / TRACK_HEIGHT);
  return index < trackCount ? index : -1;
}

/**
 * Viewport Y of a track row's top edge, given the container and scroll. Used to
 * synthesize a track rect when dnd-kit hasn't supplied an `over` droppable.
 */
export function getSynthesizedTrackTop(
  containerTopPx: number,
  scrollTop: number,
  trackIndex: number,
): number {
  return containerTopPx - scrollTop + RULER_HEIGHT + trackIndex * TRACK_HEIGHT;
}

/**
 * Decide whether a drag should insert a new track (interstitial) based on the
 * dragged item's vertical centre relative to a track row's edges. Returns the
 * insert gap index (above = trackIndex, below = trackIndex + 1) or null to drop
 * onto the row itself.
 */
export function getInterstitialGapIndex(
  dragCenterY: number,
  trackTop: number,
  trackBottom: number,
  trackHeight: number,
  trackIndex: number,
  thresholdRatio: number = INTERSTITIAL_ZONE_RATIO,
): number | null {
  const threshold = trackHeight * thresholdRatio;
  if (Math.abs(dragCenterY - trackTop) < threshold) {
    return trackIndex;
  }
  if (Math.abs(dragCenterY - trackBottom) < threshold) {
    return trackIndex + 1;
  }
  return null;
}

export interface TimelineDropTargetInput {
  /** Cursor position in viewport coordinates. */
  cursorX: number;
  cursorY: number;
  /** The scroll container's bounding rect (viewport) and scroll offsets. */
  containerLeftPx: number;
  containerTopPx: number;
  containerBottomPx: number;
  scrollLeft: number;
  scrollTop: number;
  /** Number of tracks currently in the timeline. */
  trackCount: number;
  /** Duration of the ghost footprint, used for end-edge snapping. */
  ghostDurationTicks: number;
  /** Ghost height in px; defaults to the standard clip height. */
  ghostHeightPx?: number;
  ticksToPx: (ticks: number) => number;
  pxToTicks: (px: number) => number;
  /** Optional clip-edge / playhead snapping. */
  snap?: {
    points: number[];
    enabled: boolean;
    thresholdPx?: number;
  };
  insertThresholdRatio?: number;
  /**
   * Horizontal distance (px) the ghost's left edge sits left of the cursor.
   * Defaults to the asset grab offset; pass 0 to anchor the footprint's left
   * edge at the cursor (used for transform-card drops).
   */
  ghostOffsetX?: number;
}

export interface TimelineDropTarget {
  /** Track row under the cursor, or -1 when outside the stack. */
  trackIndex: number;
  /** Insert gap index for an interstitial drop, or null to drop on a row. */
  interstitialGapIndex: number | null;
  /** Unsnapped start tick from the ghost's left edge. */
  rawStartTicks: number;
  /** Snapped start tick when a snap candidate was within threshold, else null. */
  snappedStartTicks: number | null;
  /** The snap point that was matched (for the snap-line indicator), else null. */
  snapTick: number | null;
}

/**
 * Resolve a cursor-driven drag (a new asset or a transform card) to a timeline
 * drop target. The ghost rect is positioned via the shared `getGhostClipPosition`
 * so the start tick (ghost left edge) and interstitial decision (ghost vertical
 * centre) are consistent with what the overlay renders.
 */
export function resolveTimelineDropTarget(
  input: TimelineDropTargetInput,
): TimelineDropTarget {
  const height = input.ghostHeightPx ?? GHOST_CLIP_HEIGHT;
  const ghost = getGhostClipPosition(
    input.cursorX,
    input.cursorY,
    height,
    input.ghostOffsetX,
  );
  const ghostCenterY = ghost.y + height / 2;

  const rawStartTicks = getTickFromDragLeft(
    ghost.x,
    input.containerLeftPx,
    input.scrollLeft,
    input.pxToTicks,
  );

  const trackIndex = getTrackIndexAtY(
    input.cursorY,
    input.containerTopPx,
    input.containerBottomPx,
    input.scrollTop,
    input.trackCount,
  );

  let interstitialGapIndex: number | null = null;
  if (trackIndex !== -1) {
    const trackTop = getSynthesizedTrackTop(
      input.containerTopPx,
      input.scrollTop,
      trackIndex,
    );
    interstitialGapIndex = getInterstitialGapIndex(
      ghostCenterY,
      trackTop,
      trackTop + TRACK_HEIGHT,
      TRACK_HEIGHT,
      trackIndex,
      input.insertThresholdRatio,
    );
  }

  let snappedStartTicks: number | null = null;
  let snapTick: number | null = null;
  if (input.snap && input.snap.enabled && input.snap.points.length > 0) {
    const candidate = getMoveSnapCandidate(
      rawStartTicks,
      input.ghostDurationTicks,
      input.snap.points,
      input.ticksToPx,
      input.snap.thresholdPx ?? SNAP_THRESHOLD_PX,
    );
    if (candidate) {
      snappedStartTicks = Math.max(0, candidate.snappedStartTicks);
      snapTick = candidate.snapTick;
    }
  }

  return {
    trackIndex,
    interstitialGapIndex,
    rawStartTicks,
    snappedStartTicks,
    snapTick,
  };
}
