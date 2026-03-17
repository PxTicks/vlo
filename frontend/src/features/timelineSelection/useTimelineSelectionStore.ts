import { create } from "zustand";

export interface TimelineSelectionState {
  selectionMode: boolean;
  selectionStartTick: number;
  selectionEndTick: number;
  selectionFpsOverride: number | null;
  selectionFrameStep: number;
  selectionRecommendedFps: number | null;
  selectionRecommendedFrameStep: number | null;
  selectionRecommendedMaxTicks: number | null;
  enterSelectionMode: (startTick: number, endTick: number) => void;
  updateSelectionStart: (tick: number) => void;
  updateSelectionEnd: (tick: number) => void;
  setSelectionFpsOverride: (fps: number | null) => void;
  setSelectionFrameStep: (step: number) => void;
  setSelectionRecommendations: (options: {
    fps?: number | null;
    frameStep?: number | null;
    maxTicks?: number | null;
  }) => void;
  clearSelectionRecommendations: () => void;
  exitSelectionMode: () => void;
}

export const useTimelineSelectionStore = create<TimelineSelectionState>((set) => ({
  selectionMode: false,
  selectionStartTick: 0,
  selectionEndTick: 0,
  selectionFpsOverride: null,
  selectionFrameStep: 1,
  selectionRecommendedFps: null,
  selectionRecommendedFrameStep: null,
  selectionRecommendedMaxTicks: null,
  enterSelectionMode: (startTick, endTick) =>
    set({
      selectionMode: true,
      selectionStartTick: startTick,
      selectionEndTick: endTick,
    }),
  updateSelectionStart: (tick) => set({ selectionStartTick: tick }),
  updateSelectionEnd: (tick) => set({ selectionEndTick: tick }),
  setSelectionFpsOverride: (fps) =>
    set({
      selectionFpsOverride:
        typeof fps === "number" && Number.isFinite(fps) && fps > 0
          ? Math.max(1, Math.round(fps))
          : null,
    }),
  setSelectionFrameStep: (step) =>
    set({
      selectionFrameStep:
        typeof step === "number" && Number.isFinite(step) && step > 0
          ? Math.max(1, Math.round(step))
          : 1,
    }),
  setSelectionRecommendations: ({ fps, frameStep, maxTicks }) =>
    set({
      selectionRecommendedFps:
        typeof fps === "number" && Number.isFinite(fps) && fps > 0
          ? Math.max(1, Math.round(fps))
          : null,
      selectionRecommendedFrameStep:
        typeof frameStep === "number" &&
        Number.isFinite(frameStep) &&
        frameStep > 0
          ? Math.max(1, Math.round(frameStep))
          : null,
      selectionRecommendedMaxTicks:
        typeof maxTicks === "number" && Number.isFinite(maxTicks) && maxTicks > 0
          ? maxTicks
          : null,
    }),
  clearSelectionRecommendations: () =>
    set({
      selectionRecommendedFps: null,
      selectionRecommendedFrameStep: null,
      selectionRecommendedMaxTicks: null,
    }),
  exitSelectionMode: () =>
    set({
      selectionMode: false,
      selectionStartTick: 0,
      selectionEndTick: 0,
      selectionRecommendedFps: null,
      selectionRecommendedFrameStep: null,
      selectionRecommendedMaxTicks: null,
    }),
}));
