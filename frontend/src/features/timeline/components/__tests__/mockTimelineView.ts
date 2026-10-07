import { useSyncExternalStore } from "react";
import { act } from "@testing-library/react";
import { vi } from "vitest";
import { TRACK_HEADER_WIDTH } from "../../constants";
import type { TimelineViewState } from "../../hooks/useTimelineViewStore";
import { visiblePixelWindowForViewport } from "../../utils/visibleTimelineClips";

/**
 * A stand-in for `useTimelineViewStore` in canvas tests. `scrollTo` moves the
 * published pixel window the way the timeline container does, and subscribed
 * components re-render as they would against the real store.
 */
export interface MockTimelineView {
  useStore: (selector?: (state: TimelineViewState) => unknown) => unknown;
  /** Scroll the timeline so `scrollLeft` (timeline px) is the viewport's left edge. */
  scrollTo: (scrollLeft: number) => void;
}

export function createMockTimelineView({
  zoomScale = 1,
  contentWidth = 1000,
}: { zoomScale?: number; contentWidth?: number } = {}): MockTimelineView {
  const listeners = new Set<() => void>();
  const viewportWidth = contentWidth + TRACK_HEADER_WIDTH;
  let state: TimelineViewState = {
    zoomScale,
    setZoomScale: vi.fn(),
    minZoomScale: 0.1,
    setMinZoomScale: vi.fn(),
    ticksToPx: (ticks: number) => ticks,
    pxToTicks: (px: number) => px,
    scrollContainer: null,
    setScrollContainer: vi.fn(),
    visiblePixelWindow: visiblePixelWindowForViewport(0, viewportWidth, null),
    setVisiblePixelWindow: vi.fn(),
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    useStore: (selector) =>
      // eslint-disable-next-line react-hooks/rules-of-hooks -- stands in for a hook
      useSyncExternalStore(subscribe, () =>
        selector ? selector(state) : state,
      ),
    scrollTo: (scrollLeft) => {
      act(() => {
        state = {
          ...state,
          visiblePixelWindow: visiblePixelWindowForViewport(
            scrollLeft,
            viewportWidth,
            state.visiblePixelWindow,
          ),
        };
        listeners.forEach((listener) => listener());
      });
    },
  };
}
