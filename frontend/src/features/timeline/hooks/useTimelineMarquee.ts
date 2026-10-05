// hooks/useTimelineMarquee.ts
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTimelineStore } from "../useTimelineStore";
import { useTimelineViewStore } from "./useTimelineViewStore";
import { useInteractionStore } from "./useInteractionStore";
import { useProjectStore } from "../../project/useProjectStore";
import { useTimelineSelectionStore } from "../../timelineSelection";
import { getTimelineTime } from "../time/index";
import { RULER_HEIGHT, TRACK_HEADER_WIDTH } from "../constants";
import {
  buildMarqueeClipBoxes,
  mergeMarqueeSelection,
  resolveMarqueeHits,
  type MarqueeClipBox,
} from "../utils/marqueeSelection";

/** Same travel the clip PointerSensor needs, so a press reads alike everywhere. */
const ACTIVATION_DISTANCE_PX = 3;
const AUTO_SCROLL_EDGE_PX = 32;
const AUTO_SCROLL_MAX_STEP_PX = 20;

/**
 * Empty space a marquee may start from: a track body, or the track area below
 * the last row. Matched against the press target itself, never an ancestor —
 * clips and overlays live inside the track area too.
 */
const MARQUEE_SURFACE_SELECTOR =
  '[data-testid="timeline-body"], [data-timeline-marquee-surface]';

/** The marquee rectangle in the scroll container's content pixels. */
export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface MarqueeGestureCallbacks {
  onRect: (rect: MarqueeRect | null) => void;
  onActivate: () => void;
  onFinish: () => void;
}

function toContentPoint(
  container: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const bounds = container.getBoundingClientRect();
  return {
    x: clientX - bounds.left + container.scrollLeft,
    y: clientY - bounds.top + container.scrollTop,
  };
}

/** Scroll step for a pointer near (or past) either end of `[min, max]`. */
function edgeScrollStep(position: number, min: number, max: number): number {
  const ramp = (depth: number) =>
    Math.ceil(
      AUTO_SCROLL_MAX_STEP_PX * Math.min(1, depth / AUTO_SCROLL_EDGE_PX),
    );
  if (position < min + AUTO_SCROLL_EDGE_PX) {
    return -ramp(min + AUTO_SCROLL_EDGE_PX - position);
  }
  if (position > max - AUTO_SCROLL_EDGE_PX) {
    return ramp(position - (max - AUTO_SCROLL_EDGE_PX));
  }
  return 0;
}

/**
 * Swallow the click the browser dispatches after a marquee's pointerup, so the
 * container's click handler doesn't clear the new selection and seek.
 */
function suppressNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  // The click is dispatched in the same task as pointerup (or not at all, when
  // press and release had no common target); drop the guard once it has had
  // its chance so a later genuine click is untouched.
  window.setTimeout(() => {
    window.removeEventListener("click", swallow, { capture: true });
  }, 0);
}

function beginMarqueeGesture(
  container: HTMLElement,
  down: PointerEvent,
  callbacks: MarqueeGestureCallbacks,
): () => void {
  const origin = toContentPoint(container, down.clientX, down.clientY);
  const {
    selectedClipIds: initialClipIds,
    selectedTransitionId: initialTransitionId,
  } = useTimelineStore.getState();
  const additive = down.shiftKey || down.ctrlKey || down.metaKey;
  let baseSelection: readonly string[] = additive ? initialClipIds : [];

  let pointer = { x: down.clientX, y: down.clientY };
  let phase: "pending" | "active" | "cancelled" = "pending";
  let boxes: MarqueeClipBox[] = [];
  let frame: number | null = null;
  let previousUserSelect = "";
  let unsubscribeTimeline: (() => void) | null = null;

  const update = () => {
    const current = toContentPoint(container, pointer.x, pointer.y);
    const clampX = (x: number) =>
      Math.min(container.scrollWidth, Math.max(TRACK_HEADER_WIDTH, x));
    const clampY = (y: number) =>
      Math.min(container.scrollHeight, Math.max(RULER_HEIGHT, y));
    const left = clampX(Math.min(origin.x, current.x));
    const right = clampX(Math.max(origin.x, current.x));
    const top = clampY(Math.min(origin.y, current.y));
    const bottom = clampY(Math.max(origin.y, current.y));
    callbacks.onRect({ left, top, width: right - left, height: bottom - top });

    const { pxToTicks } = useTimelineViewStore.getState();
    const hits = resolveMarqueeHits(
      {
        startTick: pxToTicks(left - TRACK_HEADER_WIDTH),
        endTick: pxToTicks(right - TRACK_HEADER_WIDTH),
        top,
        bottom,
      },
      boxes,
    );
    useTimelineStore
      .getState()
      .setSelectedClips(mergeMarqueeSelection(baseSelection, hits));
  };

  const autoScroll = () => {
    const bounds = container.getBoundingClientRect();
    const dx = edgeScrollStep(
      pointer.x,
      bounds.left + TRACK_HEADER_WIDTH,
      bounds.right,
    );
    const dy = edgeScrollStep(
      pointer.y,
      bounds.top + RULER_HEIGHT,
      bounds.bottom,
    );
    // The container's scroll listener re-runs the hit test.
    if (dx !== 0) container.scrollLeft += dx;
    if (dy !== 0) container.scrollTop += dy;
    frame = requestAnimationFrame(autoScroll);
  };

  const resolveBoxes = () => {
    const { clips, tracks } = useTimelineStore.getState();
    const fps = useProjectStore.getState().config.fps;
    boxes = buildMarqueeClipBoxes(
      clips,
      tracks,
      getTimelineTime({ tracks, clips, fps }).presentationIndex(),
    );
    const clipIds = new Set(clips.map((clip) => clip.id));
    baseSelection = baseSelection.filter((id) => clipIds.has(id));
  };

  const activate = () => {
    phase = "active";
    resolveBoxes();
    // Keyboard commands (delete, undo, paste) stay live under a held marquee;
    // re-resolve footprints so the box never selects clips that are gone.
    unsubscribeTimeline = useTimelineStore.subscribe((state, previous) => {
      if (state.clips === previous.clips && state.tracks === previous.tracks) {
        return;
      }
      resolveBoxes();
      update();
    });
    previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    window.getSelection()?.removeAllRanges();
    callbacks.onActivate();
    frame = requestAnimationFrame(autoScroll);
  };

  const stopVisuals = () => {
    unsubscribeTimeline?.();
    unsubscribeTimeline = null;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (phase === "active") document.body.style.userSelect = previousUserSelect;
    callbacks.onRect(null);
  };

  const handleMove = (event: PointerEvent) => {
    if (event.pointerId !== down.pointerId) return;
    pointer = { x: event.clientX, y: event.clientY };
    if (phase === "pending") {
      const travel = Math.hypot(
        pointer.x - down.clientX,
        pointer.y - down.clientY,
      );
      if (travel < ACTIVATION_DISTANCE_PX) return;
      activate();
    }
    if (phase === "active") update();
  };

  const handleScroll = () => {
    if (phase === "active") update();
  };

  const restoreInitialSelection = () => {
    const state = useTimelineStore.getState();
    if (
      initialTransitionId !== null &&
      state.transitions.some(
        (transition) => transition.id === initialTransitionId,
      )
    ) {
      state.selectTransition(initialTransitionId);
      return;
    }
    const clipIds = new Set(state.clips.map((clip) => clip.id));
    state.setSelectedClips(initialClipIds.filter((id) => clipIds.has(id)));
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || phase !== "active") return;
    event.preventDefault();
    event.stopPropagation();
    restoreInitialSelection();
    stopVisuals();
    phase = "cancelled";
  };

  const finish = () => {
    stopVisuals();
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("keydown", handleKeyDown, { capture: true });
    container.removeEventListener("scroll", handleScroll);
    callbacks.onFinish();
  };

  function handleUp(event: PointerEvent) {
    if (event.pointerId !== down.pointerId) return;
    // A drag — even one Escape cancelled — is not a click.
    if (phase !== "pending") suppressNextClick();
    finish();
  }

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp);
  // Also how cancelTimelineInteractions ends in-flight timeline gestures.
  window.addEventListener("pointercancel", finish);
  window.addEventListener("keydown", handleKeyDown, { capture: true });
  container.addEventListener("scroll", handleScroll);
  return finish;
}

/**
 * Click-and-drag on empty track space to box-select clips. The marquee writes
 * an ordinary clip selection (`setSelectedClips`), live as it moves, so the
 * result is indistinguishable from a ctrl/shift-click multiselection.
 * Holding shift/ctrl/cmd at the press adds to the existing selection.
 *
 * Returns the rectangle to draw, or null when no marquee is active.
 */
export function useTimelineMarquee(
  scrollContainerRef: RefObject<HTMLDivElement | null>,
  onActivate?: () => void,
): MarqueeRect | null {
  const [rect, setRect] = useState<MarqueeRect | null>(null);
  const onActivateRef = useRef(onActivate);
  useEffect(() => {
    onActivateRef.current = onActivate;
  }, [onActivate]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let endGesture: (() => void) | null = null;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || endGesture !== null) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target !== container && !target.matches(MARQUEE_SURFACE_SELECTOR)) {
        return;
      }
      // The generation range picker owns presses on the track area.
      if (useTimelineSelectionStore.getState().selectionMode) return;
      if (useInteractionStore.getState().activeId !== null) return;

      endGesture = beginMarqueeGesture(container, event, {
        onRect: setRect,
        onActivate: () => onActivateRef.current?.(),
        onFinish: () => {
          endGesture = null;
        },
      });
    };

    container.addEventListener("pointerdown", handlePointerDown);
    return () => {
      container.removeEventListener("pointerdown", handlePointerDown);
      endGesture?.();
    };
  }, [scrollContainerRef]);

  return rect;
}
