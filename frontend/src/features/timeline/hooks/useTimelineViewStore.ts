// hooks/useTimelineViewStore.ts
import { create } from "zustand";
import {
  TICKS_PER_SECOND,
  PIXELS_PER_SECOND,
  MIN_ZOOM,
  MAX_ZOOM,
} from "../constants";

export interface TimelineViewState {
  zoomScale: number;
  setZoomScale: (scale: number) => void;

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
    set({ zoomScale: Math.max(MIN_ZOOM, Math.min(scale, MAX_ZOOM)) }),

  ticksToPx: (ticks: number) => {
    const { zoomScale } = get();
    return (ticks / TICKS_PER_SECOND) * PIXELS_PER_SECOND * zoomScale;
  },

  pxToTicks: (px: number) => {
    const { zoomScale } = get();
    const safeScale = Math.max(0.001, zoomScale);
    return Math.round(
      (px / (PIXELS_PER_SECOND * safeScale)) * TICKS_PER_SECOND,
    );
  },

  scrollContainer: null,
  setScrollContainer: (element) => set({ scrollContainer: element }),
}));
