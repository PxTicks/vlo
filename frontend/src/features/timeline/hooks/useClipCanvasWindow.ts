import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import type {
  AssetBackedBaseClip,
  AssetBackedTimelineClip,
  TimelineClip,
} from "../../../types/TimelineTypes";
import { ticksToPx } from "../../../core/time/pixelGrid";
import { useInteractionStore } from "./useInteractionStore";
import { useTimelineViewStore } from "./useTimelineViewStore";

const INITIAL_WING_SIZE = 1000;
const WING_GROWTH_CHUNK = 2000;
const EXPANSION_THRESHOLD = 300;
const MAX_DRAGGING_CANVAS_WIDTH = 16384;

export interface ClipCanvasGeometry {
  localStart: number;
  localWidth: number;
}

interface UseClipCanvasWindowProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  clip: AssetBackedBaseClip | AssetBackedTimelineClip;
  zoomScale: number;
  height: number;
  enabled?: boolean;
  isDragging?: boolean;
  presentationStart?: number;
  presentationDuration?: number;
}

interface UseClipCanvasWindowResult {
  clipStart: number | null;
  fullCanvasWidth: number;
  leftWingPx: number;
  /**
   * Whether the clip's canvas window overlaps the timeline's visible pixel
   * window. Pure: never touches the canvas.
   */
  isNearViewport: () => boolean;
  updateCanvasGeometry: () => ClipCanvasGeometry | null;
  /**
   * Call `listener` after the visible pixel window moves. The window moves in
   * overscan-sized steps, so this replaces a per-clip scroll listener.
   */
  subscribeToVisibleWindow: (listener: () => void) => () => void;
}

export function useClipCanvasWindow({
  canvasRef,
  clip,
  zoomScale,
  height,
  enabled = true,
  isDragging = false,
  presentationStart,
  presentationDuration,
}: UseClipCanvasWindowProps): UseClipCanvasWindowResult {
  const [dynamicWings, setDynamicWings] = useState({
    left: INITIAL_WING_SIZE,
    right: INITIAL_WING_SIZE,
  });

  const clipStart = "start" in clip ? (clip as TimelineClip).start : null;
  const layoutRef = useRef({
    canvasLeft: -1,
    canvasHeight: -1,
    canvasWidth: -1,
  });
  const visibleWindow = useTimelineViewStore(
    (state) => state.visiblePixelWindow,
  );
  // Read through a ref so a window move doesn't rebuild the geometry
  // callbacks, which would restart the consumers' fetch effects.
  const visibleWindowRef = useRef(visibleWindow);
  const windowListenersRef = useRef(new Set<() => void>());

  // Reset wing sizes during render whenever the active clip/asset changes or
  // the hook is re-enabled, using the "store previous render value" pattern.
  const [lastResetKey, setLastResetKey] = useState<string>(
    `${clip.id}|${clip.assetId}|${enabled}`,
  );
  const currentResetKey = `${clip.id}|${clip.assetId}|${enabled}`;
  if (lastResetKey !== currentResetKey) {
    setLastResetKey(currentResetKey);
    setDynamicWings({ left: INITIAL_WING_SIZE, right: INITIAL_WING_SIZE });
  }

  useLayoutEffect(() => {
    if (visibleWindowRef.current === visibleWindow) {
      return;
    }
    visibleWindowRef.current = visibleWindow;
    for (const listener of windowListenersRef.current) {
      listener();
    }
  }, [visibleWindow]);

  const subscribeToVisibleWindow = useCallback((listener: () => void) => {
    const listeners = windowListenersRef.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

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

  useEffect(() => {
    // Invalidate scratch layout cache when the underlying asset swaps so the
    // next render re-measures the canvas geometry from scratch.
    layoutRef.current = {
      canvasLeft: -1,
      canvasHeight: -1,
      canvasWidth: -1,
    };
  }, [clip.assetId]);

  const visibleDurationTicks = presentationDuration ?? clip.timelineDuration;
  const visibleDurationPx = ticksToPx(visibleDurationTicks, zoomScale);
  const maxLeftPx = ticksToPx(clip.transformedOffset, zoomScale);
  const leftWingPx = Math.min(maxLeftPx, dynamicWings.left);
  const hasUnboundedRightSide =
    clip.type === "image" || clip.sourceDuration === null;
  const remainingRightTicks = hasUnboundedRightSide
    ? 0
    : clip.transformedDuration - clip.transformedOffset - clip.timelineDuration;
  const maxRightPx = hasUnboundedRightSide
    ? Number.POSITIVE_INFINITY
    : ticksToPx(remainingRightTicks, zoomScale);
  const rightWingPx = hasUnboundedRightSide
    ? dynamicWings.right
    : Math.min(Math.max(0, maxRightPx), dynamicWings.right);
  const fullCanvasWidth = leftWingPx + visibleDurationPx + rightWingPx;

  // The slice of the canvas window inside the visible pixel window, or null
  // when the clip is entirely outside it. The window already overscans the
  // viewport. Dragged/unplaced clips always use the whole (capped) window.
  const resolveVisibleSpan = useCallback((): ClipCanvasGeometry | null => {
    if (isDragging || clipStart === null) {
      return {
        localStart: 0,
        localWidth: Math.min(
          MAX_DRAGGING_CANVAS_WIDTH,
          Math.ceil(fullCanvasWidth),
        ),
      };
    }

    const pixelWindow = visibleWindowRef.current;
    if (!pixelWindow) {
      return null;
    }
    const layoutStart = presentationStart ?? clipStart;
    const clipGlobalStart = ticksToPx(layoutStart, zoomScale);
    const virtualGlobalStart = clipGlobalStart - leftWingPx;
    const localStart = Math.max(0, pixelWindow.start - virtualGlobalStart);
    const localEnd = Math.min(
      fullCanvasWidth,
      pixelWindow.end - virtualGlobalStart,
    );

    if (localEnd <= localStart) {
      return null;
    }

    return {
      localStart: Math.floor(localStart),
      localWidth: Math.ceil(localEnd - localStart),
    };
  }, [
    clipStart,
    fullCanvasWidth,
    isDragging,
    leftWingPx,
    presentationStart,
    zoomScale,
  ]);

  const isNearViewport = useCallback(
    () => visibleWindowRef.current !== null && resolveVisibleSpan() !== null,
    [resolveVisibleSpan],
  );

  const updateCanvasGeometry = useCallback((): ClipCanvasGeometry | null => {
    if (!visibleWindowRef.current || !canvasRef.current) {
      return null;
    }

    const span = resolveVisibleSpan();
    if (!span) {
      return null;
    }
    const intLocalStart = span.localStart;
    const intWidth = span.localWidth;

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
    height,
    leftWingPx,
    resolveVisibleSpan,
  ]);

  return {
    clipStart,
    fullCanvasWidth,
    leftWingPx,
    isNearViewport,
    updateCanvasGeometry,
    subscribeToVisibleWindow,
  };
}
