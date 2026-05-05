import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { BaseClip, TimelineClip } from "../../../types/TimelineTypes";
import { PIXELS_PER_SECOND, TICKS_PER_SECOND } from "../constants";
import { useInteractionStore } from "./useInteractionStore";
import { useTimelineViewStore } from "./useTimelineViewStore";

const INITIAL_WING_SIZE = 1000;
const WING_GROWTH_CHUNK = 2000;
const EXPANSION_THRESHOLD = 300;
const MAX_DRAGGING_CANVAS_WIDTH = 16384;
const VIEWPORT_BUFFER_PX = 1000;

export interface ClipCanvasGeometry {
  localStart: number;
  localWidth: number;
}

interface UseClipCanvasWindowProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  clip: BaseClip;
  zoomScale: number;
  height: number;
  enabled?: boolean;
  isDragging?: boolean;
}

interface UseClipCanvasWindowResult {
  clipStart: number | null;
  fullCanvasWidth: number;
  leftWingPx: number;
  scrollContainer: HTMLElement | null;
  updateCanvasGeometry: () => ClipCanvasGeometry | null;
  updateViewportState: () => void;
}

export function useClipCanvasWindow({
  canvasRef,
  clip,
  zoomScale,
  height,
  enabled = true,
  isDragging = false,
}: UseClipCanvasWindowProps): UseClipCanvasWindowResult {
  const [dynamicWings, setDynamicWings] = useState({
    left: INITIAL_WING_SIZE,
    right: INITIAL_WING_SIZE,
  });

  const clipStart = "start" in clip ? (clip as TimelineClip).start : null;
  const layoutRef = useRef({ canvasLeft: -1, canvasHeight: -1, canvasWidth: -1 });
  const viewportRef = useRef({ scrollLeft: 0, containerWidth: 0 });
  const scrollContainer = useTimelineViewStore((state) => state.scrollContainer);

  const updateViewportState = useCallback(() => {
    if (!scrollContainer) {
      return;
    }

    viewportRef.current = {
      scrollLeft: scrollContainer.scrollLeft,
      containerWidth: scrollContainer.clientWidth,
    };
  }, [scrollContainer]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    setDynamicWings({ left: INITIAL_WING_SIZE, right: INITIAL_WING_SIZE });

    const unsubscribe = useInteractionStore.subscribe((state) => {
      const isLeft = state.activeId === `resize_left_${clip.id}`;
      const isRight = state.activeId === `resize_right_${clip.id}`;

      if (!isLeft && !isRight) {
        return;
      }

      const dragDistance = Math.abs(state.currentDeltaX);
      setDynamicWings((previous) => {
        if (isLeft && dragDistance > previous.left - EXPANSION_THRESHOLD) {
          return { ...previous, left: previous.left + WING_GROWTH_CHUNK };
        }

        if (isRight && dragDistance > previous.right - EXPANSION_THRESHOLD) {
          return { ...previous, right: previous.right + WING_GROWTH_CHUNK };
        }

        return previous;
      });
    });

    return () => unsubscribe();
  }, [clip.id, enabled]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    updateViewportState();
  }, [enabled, isDragging, updateViewportState]);

  useEffect(() => {
    layoutRef.current = {
      canvasLeft: -1,
      canvasHeight: -1,
      canvasWidth: -1,
    };
    setDynamicWings({ left: INITIAL_WING_SIZE, right: INITIAL_WING_SIZE });
  }, [clip.assetId]);

  const visibleDurationPx =
    (clip.timelineDuration / TICKS_PER_SECOND) * PIXELS_PER_SECOND * zoomScale;
  const maxLeftPx =
    (clip.transformedOffset / TICKS_PER_SECOND) * PIXELS_PER_SECOND * zoomScale;
  const leftWingPx = Math.min(maxLeftPx, dynamicWings.left);
  const hasUnboundedRightSide =
    clip.type === "image" || clip.sourceDuration === null;
  const remainingRightTicks = hasUnboundedRightSide
    ? 0
    : clip.transformedDuration - clip.transformedOffset - clip.timelineDuration;
  const maxRightPx = hasUnboundedRightSide
    ? Number.POSITIVE_INFINITY
    : (remainingRightTicks / TICKS_PER_SECOND) * PIXELS_PER_SECOND * zoomScale;
  const rightWingPx = hasUnboundedRightSide
    ? dynamicWings.right
    : Math.min(Math.max(0, maxRightPx), dynamicWings.right);
  const fullCanvasWidth = leftWingPx + visibleDurationPx + rightWingPx;

  const updateCanvasGeometry = useCallback((): ClipCanvasGeometry | null => {
    if (!scrollContainer || !canvasRef.current) {
      return null;
    }

    let intLocalStart = 0;
    let intWidth = 0;

    if (isDragging || clipStart === null) {
      intLocalStart = 0;
      intWidth = Math.min(MAX_DRAGGING_CANVAS_WIDTH, Math.ceil(fullCanvasWidth));
    } else {
      const { scrollLeft, containerWidth } = viewportRef.current;
      const clipGlobalStart =
        (clipStart / TICKS_PER_SECOND) * PIXELS_PER_SECOND * zoomScale;
      const virtualGlobalStart = clipGlobalStart - leftWingPx;
      const viewStart = scrollLeft - VIEWPORT_BUFFER_PX;
      const viewEnd = scrollLeft + containerWidth + VIEWPORT_BUFFER_PX;
      const localStart = Math.max(0, viewStart - virtualGlobalStart);
      const localEnd = Math.min(fullCanvasWidth, viewEnd - virtualGlobalStart);

      if (localEnd <= localStart) {
        return null;
      }

      intWidth = Math.ceil(localEnd - localStart);
      intLocalStart = Math.floor(localStart);
    }

    const canvas = canvasRef.current;
    const baseLeft = -leftWingPx + intLocalStart;

    if (canvas.width !== intWidth || canvas.height !== height) {
      canvas.width = intWidth;
      canvas.height = height;
    }

    const transform = `translateX(calc(${baseLeft}px - var(--drag-delta-x, 0px)))`;

    if (
      layoutRef.current.canvasLeft !== intLocalStart ||
      layoutRef.current.canvasWidth !== intWidth ||
      layoutRef.current.canvasHeight !== height ||
      canvas.style.transform !== transform
    ) {
      canvas.style.transform = transform;
      layoutRef.current = {
        canvasLeft: intLocalStart,
        canvasHeight: height,
        canvasWidth: intWidth,
      };
    }

    return { localStart: intLocalStart, localWidth: intWidth };
  }, [
    canvasRef,
    clipStart,
    fullCanvasWidth,
    height,
    isDragging,
    leftWingPx,
    scrollContainer,
    zoomScale,
  ]);

  return {
    clipStart,
    fullCanvasWidth,
    leftWingPx,
    scrollContainer,
    updateCanvasGeometry,
    updateViewportState,
  };
}
