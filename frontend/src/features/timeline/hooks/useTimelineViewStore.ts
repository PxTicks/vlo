// hooks/useTimelineViewStore.ts
import { create } from "zustand";
import { MIN_ZOOM, MAX_ZOOM } from "../constants";
import {
  ticksToPx as ticksToPxAt,
  pxToTicks as pxToTicksAt,
} from "../../../core/time/pixelGrid";

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

  ticksToPx: (ticks: number) => ticksToPxAt(ticks, get().zoomScale),

  pxToTicks: (px: number) => Math.round(pxToTicksAt(px, get().zoomScale)),

  scrollContainer: null,
  setScrollContainer: (element) => set({ scrollContainer: element }),
}));
