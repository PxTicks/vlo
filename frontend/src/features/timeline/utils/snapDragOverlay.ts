import type { TimelineClip } from "../../../types/TimelineTypes";
import {
  calculateClipTime,
  getTransformInputTimeAtVisualOffset,
  mapLayerInputToVisualTime,
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

interface BuildLayerTimeDragOptions {
  clip: TimelineClip;
  /** Transform whose input domain anchors the keyframe time. */
  transformId: string;
  /** Stored layer-input time at drag-start. */
  initialLayerInputTicks: number;
  /**
   * Layer-input time of the previous keyframe in the same transform.
   * Pass `null` if the dragged keyframe is the first.
   */
  prevNeighborLayerInputTicks: number | null;
  /**
   * Layer-input time of the next keyframe in the same transform.
   * Pass `null` if the dragged keyframe is the last.
   */
  nextNeighborLayerInputTicks: number | null;
  /**
   * Minimum required input-tick separation between the committed time and
   * either neighbor. A 1-frame visual gap can collapse to a fraction of a
   * tick under heavy speed compression — without this guard, the spline
   * `upsertSplinePoint` epsilon (`<= 1` ticks) would silently merge points
   * and the spline gradient would blow up where points share a time.
   */
  minNeighborSeparationTicks?: number;
  getTicksPerFrame: () => number;
  getZoomScale: () => number;
  /** Called on drag-end with the snapped, layer-input-encoded position. */
  onCommit: (snappedLayerInputTicks: number) => void;
}

/**
 * Returns drag handlers for a `layerTime`-placed overlay item (e.g. a
 * keyframe diamond) that should snap to whole project frames on drop and
 * stay strictly between its prev/next siblings.
 *
 * Bounds rule (per spec): the committed visual position is the largest
 * frame strictly less than `nextNeighbor`'s visual position, and the
 * smallest frame strictly greater than `prevNeighbor`'s visual position.
 * If a chosen frame's *layer-input* time still lies within
 * `minNeighborSeparationTicks` of a neighbor (extreme speed compression),
 * we step further by additional frames until the input-domain separation
 * is satisfied. If no such frame exists inside the visual band, the
 * commit falls back to the initial position.
 */
export function buildFrameSnappedLayerTimeDrag(
  options: BuildLayerTimeDragOptions,
): TimelineClipOverlayItemDrag {
  const {
    clip,
    transformId,
    initialLayerInputTicks,
    prevNeighborLayerInputTicks,
    nextNeighborLayerInputTicks,
    minNeighborSeparationTicks = 2,
    getTicksPerFrame,
    getZoomScale,
    onCommit,
  } = options;

  const anchorVisualTicks = mapLayerInputToVisualTime(
    clip,
    transformId,
    initialLayerInputTicks,
  );

  const prevVisualTicks =
    prevNeighborLayerInputTicks === null
      ? null
      : mapLayerInputToVisualTime(clip, transformId, prevNeighborLayerInputTicks);
  const nextVisualTicks =
    nextNeighborLayerInputTicks === null
      ? null
      : mapLayerInputToVisualTime(clip, transformId, nextNeighborLayerInputTicks);

  function resolveDrop(deltaVisualTimeTicks: number): {
    visualTicks: number;
    layerInputTicks: number;
  } {
    const ticksPerFrame = getTicksPerFrame();
    const candidateVisual = snapTickToFrame(
      anchorVisualTicks + deltaVisualTimeTicks,
      ticksPerFrame,
    );

    // Smallest frame strictly greater than prev's visual position; largest
    // frame strictly less than next's visual position. When the neighbor
    // already sits exactly on a frame boundary, these collapse to the
    // adjacent frame; when the neighbor is interstitial (Z = F + epsilon),
    // we still floor/ceil correctly.
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
      layerInputTicks: initialLayerInputTicks,
    };

    if (lbVisual > ubVisual) {
      // No legal whole-frame slot between the neighbors.
      return fallback;
    }

    let chosenVisual = Math.max(lbVisual, Math.min(candidateVisual, ubVisual));

    // Refine: step further from any neighbor whose input-domain separation
    // is below the safety threshold. This handles speed transforms that
    // squash multiple visual frames into a sub-tick of input time.
    const isInputSafe = (visualTicks: number): boolean => {
      const layerTicks = getTransformInputTimeAtVisualOffset(
        clip,
        transformId,
        visualTicks,
      );
      if (
        prevNeighborLayerInputTicks !== null &&
        layerTicks - prevNeighborLayerInputTicks < minNeighborSeparationTicks
      ) {
        return false;
      }
      if (
        nextNeighborLayerInputTicks !== null &&
        nextNeighborLayerInputTicks - layerTicks < minNeighborSeparationTicks
      ) {
        return false;
      }
      return true;
    };

    if (!isInputSafe(chosenVisual)) {
      // Search outward from the candidate, alternating sides, for the
      // nearest frame inside [lbVisual, ubVisual] that is input-safe.
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
          if (!isInputSafe(probe)) continue;
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

    const chosenLayer = getTransformInputTimeAtVisualOffset(
      clip,
      transformId,
      chosenVisual,
    );
    return { visualTicks: chosenVisual, layerInputTicks: chosenLayer };
  }

  return {
    onDragStart: (context) => {
      applyLiveDx(context.targetElement, 0);
    },

    onDrag: (context) => {
      const { visualTicks } = resolveDrop(context.deltaVisualTimeTicks);
      const dxBasePx =
        ticksToBasePixels(visualTicks) - ticksToBasePixels(anchorVisualTicks);
      applyLiveDx(context.targetElement, dxBasePx * getZoomScale());
    },

    onDragEnd: (context) => {
      const { layerInputTicks } = resolveDrop(context.deltaVisualTimeTicks);
      onCommit(layerInputTicks);
      clearLiveDx(context.targetElement);
    },
  };
}
