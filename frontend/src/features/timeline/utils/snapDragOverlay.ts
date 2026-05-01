import type { TimelineClip } from "../../../types/TimelineTypes";
import {
  calculateClipTime,
  mapSourceTimeToVisualTime,
} from "../../transformations";
import { snapTickToFrame } from "../../timelineSelection";
import type { TimelineClipOverlayItemDrag } from "../clipOverlayApi";
import { PIXELS_PER_SECOND, TICKS_PER_SECOND } from "../constants";

/**
 * Live-drag CSS variable read by `TimelineClipOverlayLayer`'s timed-item
 * `transform`. Writing it on the overlay's root element slides the
 * overlay item horizontally without triggering a React re-render.
 */
const LIVE_DX_VAR = "--overlay-drag-dx";

function applyLiveDx(element: HTMLElement, dx: number): void {
  element.style.setProperty(LIVE_DX_VAR, `${dx}px`);
}

function clearLiveDx(element: HTMLElement): void {
  element.style.removeProperty(LIVE_DX_VAR);
}

function ticksToBasePixels(visualTicks: number): number {
  return (visualTicks / TICKS_PER_SECOND) * PIXELS_PER_SECOND;
}

interface BuildSourceTimeDragOptions {
  clip: TimelineClip;
  /**
   * The dragged item's stored source time at drag-start. Used as the
   * anchor for live translation, so the icon follows the cursor delta
   * regardless of where on the icon the user clicked.
   */
  initialSourceTimeTicks: number;
  /**
   * Returns ticks-per-frame at drag time. A function so callers can pull
   * the live FPS from project state without stale captures.
   */
  getTicksPerFrame: () => number;
  /** Live timeline zoom (so px deltas can be computed). */
  getZoomScale: () => number;
  /** Called on drag-end with the snapped, source-time-encoded position. */
  onCommit: (snappedSourceTimeTicks: number) => void;
}

/**
 * Returns drag handlers for a `sourceTime`-placed overlay item that
 * should snap to whole project frames on drop.
 *
 * During drag, the item slides via a CSS variable (no React renders).
 * On drag-end, the candidate visual time is snapped to the nearest
 * project frame, then converted back through the clip's transform stack
 * to source-time, which the caller commits to the model. After commit,
 * the live transform is cleared and the natural re-render places the
 * icon at its new home.
 *
 * NOTE: a speed transform may render a stored marker between visual
 * frame boundaries. That is intentional — only drag re-anchors to a
 * boundary; static rendering preserves the source-time fidelity.
 */
export function buildFrameSnappedSourceTimeDrag(
  options: BuildSourceTimeDragOptions,
): TimelineClipOverlayItemDrag {
  const {
    clip,
    initialSourceTimeTicks,
    getTicksPerFrame,
    getZoomScale,
    onCommit,
  } = options;

  // Where the icon is rendered on the timeline at drag-start (clip-local
  // visual ticks). With a speed transform this may sit between frames.
  const anchorVisualTicks = mapSourceTimeToVisualTime(
    clip,
    initialSourceTimeTicks,
  );

  // The candidate visual position on each frame is anchorVisualTicks +
  // deltaVisualTimeTicks. Snapping that to the nearest project frame
  // gives the live drop preview.
  const snapCandidate = (deltaVisualTimeTicks: number): number =>
    snapTickToFrame(
      anchorVisualTicks + deltaVisualTimeTicks,
      getTicksPerFrame(),
    );

  return {
    onDragStart: (context) => {
      applyLiveDx(context.targetElement, 0);
    },

    onDrag: (context) => {
      const snappedVisualTicks = snapCandidate(context.deltaVisualTimeTicks);
      const dxBasePx =
        ticksToBasePixels(snappedVisualTicks) -
        ticksToBasePixels(anchorVisualTicks);
      applyLiveDx(context.targetElement, dxBasePx * getZoomScale());
    },

    onDragEnd: (context) => {
      const snappedVisualTicks = snapCandidate(context.deltaVisualTimeTicks);
      const snappedSourceTime = calculateClipTime(clip, snappedVisualTicks);
      onCommit(snappedSourceTime);
      clearLiveDx(context.targetElement);
    },
  };
}
