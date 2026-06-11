import type { TimelineClip } from "../../../types/TimelineTypes";
import {
  clipSourceTimeToVisual,
  clipVisualToSourceTime,
} from "../../transformations";
import { snapTickToFrame } from "../../timelineSelection";
import type {
  TimelineClipOverlayDragContext,
  TimelineClipOverlayItemDrag,
} from "../clipOverlayApi";
import { ticksToPx } from "../../../core/time/pixelGrid";

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
  return ticksToPx(visualTicks, 1);
}

function clipOffsetToPresentationBasePixels(
  context: TimelineClipOverlayDragContext,
  clipOffsetTicks: number,
): number {
  return ticksToBasePixels(
    context.mapClipOffsetToPresentationOffset(clipOffsetTicks),
  );
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
   * Source-media time of the previous keyframe/marker in the same sequence.
   * Pass `null` if the dragged item is the first.
   */
  prevNeighborSourceTimeTicks?: number | null;
  /**
   * Source-media time of the next keyframe/marker in the same sequence.
   * Pass `null` if the dragged item is the last.
   */
  nextNeighborSourceTimeTicks?: number | null;
  /**
   * Minimum required source-time separation between the committed time and
   * either neighbor. This protects spline keyframes from collapsing into
   * each other when a speed transform compresses several visual frames into
   * a tiny source-time interval.
   */
  minNeighborSeparationTicks?: number;
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
    prevNeighborSourceTimeTicks = null,
    nextNeighborSourceTimeTicks = null,
    minNeighborSeparationTicks = 2,
    getTicksPerFrame,
    getZoomScale,
    onCommit,
  } = options;

  // Where the icon is rendered on the timeline at drag-start (clip-local
  // visual ticks). With a speed transform this may sit between frames.
  const anchorVisualTicks = clipSourceTimeToVisual(clip, initialSourceTimeTicks);

  const prevVisualTicks =
    prevNeighborSourceTimeTicks === null
      ? null
      : clipSourceTimeToVisual(clip, prevNeighborSourceTimeTicks);
  const nextVisualTicks =
    nextNeighborSourceTimeTicks === null
      ? null
      : clipSourceTimeToVisual(clip, nextNeighborSourceTimeTicks);

  function resolveDrop(deltaVisualTimeTicks: number): {
    visualTicks: number;
    sourceTimeTicks: number;
  } {
    const ticksPerFrame = getTicksPerFrame();
    const candidateVisual = snapTickToFrame(
      anchorVisualTicks + deltaVisualTimeTicks,
      ticksPerFrame,
    );

    // Smallest frame strictly greater than prev's visual position; largest
    // frame strictly less than next's visual position.
    const lbVisual =
      prevVisualTicks === null
        ? -Infinity
        : (Math.floor(prevVisualTicks / ticksPerFrame) + 1) * ticksPerFrame;
    const ubVisual =
      nextVisualTicks === null
        ? Infinity
        : (Math.ceil(nextVisualTicks / ticksPerFrame) - 1) * ticksPerFrame;

    const fallback = {
      visualTicks: anchorVisualTicks,
      sourceTimeTicks: initialSourceTimeTicks,
    };

    if (lbVisual > ubVisual) {
      return fallback;
    }

    let chosenVisual = Math.max(lbVisual, Math.min(candidateVisual, ubVisual));

    const isSourceSafe = (visualTicks: number): boolean => {
      const sourceTimeTicks = clipVisualToSourceTime(clip, visualTicks);
      if (
        prevNeighborSourceTimeTicks !== null &&
        sourceTimeTicks - prevNeighborSourceTimeTicks <
          minNeighborSeparationTicks
      ) {
        return false;
      }
      if (
        nextNeighborSourceTimeTicks !== null &&
        nextNeighborSourceTimeTicks - sourceTimeTicks <
          minNeighborSeparationTicks
      ) {
        return false;
      }
      return true;
    };

    if (!isSourceSafe(chosenVisual)) {
      let bestVisual: number | null = null;
      let bestDistance = Infinity;
      const maxStep = Math.max(
        Math.ceil((ubVisual - lbVisual) / ticksPerFrame) + 1,
        1,
      );
      for (let step = 1; step <= maxStep; step += 1) {
        const offset = step * ticksPerFrame;
        for (const direction of [-1, 1] as const) {
          const probe = chosenVisual + direction * offset;
          if (probe < lbVisual || probe > ubVisual) continue;
          if (!isSourceSafe(probe)) continue;
          const distance = Math.abs(probe - candidateVisual);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestVisual = probe;
          }
        }
        if (bestVisual !== null) break;
      }
      if (bestVisual === null) {
        return fallback;
      }
      chosenVisual = bestVisual;
    }

    return {
      visualTicks: chosenVisual,
      sourceTimeTicks: clipVisualToSourceTime(clip, chosenVisual),
    };
  }

  return {
    onDragStart: (context) => {
      applyLiveDx(context.targetElement, 0);
    },

    onDrag: (context) => {
      const { visualTicks } = resolveDrop(context.deltaVisualTimeTicks);
      const dxBasePx =
        clipOffsetToPresentationBasePixels(context, visualTicks) -
        clipOffsetToPresentationBasePixels(context, anchorVisualTicks);
      applyLiveDx(context.targetElement, dxBasePx * getZoomScale());
    },

    onDragEnd: (context) => {
      const { sourceTimeTicks } = resolveDrop(context.deltaVisualTimeTicks);
      onCommit(sourceTimeTicks);
      clearLiveDx(context.targetElement);
    },
  };
}
