// hooks/useTimelineViewStore.ts
import { create } from "zustand";
import { MIN_ZOOM } from "../constants";
import { clampZoomScale } from "../utils/zoomBounds";
import {
  ticksToPx as ticksToPxAt,
  pxToTicks as pxToTicksAt,
} from "../../../core/time/pixelGrid";

export interface TimelineViewState {
  zoomScale: number;
  setZoomScale: (scale: number) => void;

  /**
   * The furthest the view may zoom out. The timeline container derives it from
   * the content length and viewport width (see `resolveMinZoomScale`).
   */
  minZoomScale: number;
  setMinZoomScale: (scale: number) => void;

  // Helpers
  ticksToPx: (ticks: number) => number;
  pxToTicks: (px: number) => number;

  // Scroll Sync for Virtualization
  scrollContainer: HTMLElement | null;
  setScrollContainer: (element: HTMLElement | null) => void;
}

export const useTimelineViewStore = create<TimelineViewState>((set, get) => ({
  zoomScale: 1,

  setZoomScale: (scale) =>
    set({ zoomScale: clampZoomScale(scale, get().minZoomScale) }),

  // A raised floor does not re-clamp the current zoom: deleting clips or
  // widening the window should not move the view under the user. The next zoom
  // gesture honours the new floor.
  minZoomScale: MIN_ZOOM,
  setMinZoomScale: (scale) => set({ minZoomScale: scale }),

  ticksToPx: (ticks: number) => ticksToPxAt(ticks, get().zoomScale),

  pxToTicks: (px: number) => Math.round(pxToTicksAt(px, get().zoomScale)),

  scrollContainer: null,
  setScrollContainer: (element) => set({ scrollContainer: element }),
}));
