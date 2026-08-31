import { create } from "zustand";
import { isProjectOutputResolution } from "../project/outputResolutionOptions";

export type TimelineSelectionStage = "range" | "tracks";

export interface TimelineSelectionState {
  selectionMode: boolean;
  selectionStage: TimelineSelectionStage;
  selectionStartTick: number;
  selectionEndTick: number;
  selectionMessage: string | null;
  selectionIncludeModeEnabled: boolean;
  selectionAllowIncludeAll: boolean;
  selectionIncludedTrackIds: string[];
  selectionFpsOverride: number | null;
  /**
   * Short edge in pixels for every render this selection produces, or `null`
   * to follow the project's own output resolution. Resolve it with
   * `resolveSelectionRenderResolution` rather than reading it directly — the
   * value a render should use also depends on the workflow's recommendation.
   */
  selectionResolutionOverride: number | null;
  selectionFrameStep: number;
  selectionFrameOffset: number;
  selectionRecommendedFps: number | null;
  /** What the workflow asks for; the override still wins. */
  selectionRecommendedResolution: number | null;
  selectionRecommendedFrameStep: number | null;
  selectionRecommendedFrameOffset: number | null;
  selectionRecommendedMaxTicks: number | null;
  enterSelectionMode: (
    startTick: number,
    endTick: number,
    options?: {
      message?: string | null;
      includeTracks?: boolean;
      allowIncludeAll?: boolean;
      includedTrackIds?: string[];
      frameStep?: number | null;
      frameOffset?: number | null;
      fpsOverride?: number | null;
      resolutionOverride?: number | null;
    },
  ) => void;
  updateSelectionStart: (tick: number) => void;
  updateSelectionEnd: (tick: number) => void;
  setSelectionMessage: (message: string | null) => void;
  enterTrackSelectionStage: () => void;
  returnToRangeSelectionStage: () => void;
  toggleSelectionIncludedTrack: (trackId: string) => void;
  includeAllSelectionTracks: (trackIds: readonly string[]) => void;
  setSelectionFpsOverride: (fps: number | null) => void;
  setSelectionResolutionOverride: (resolution: number | null) => void;
  setSelectionFrameStep: (step: number) => void;
  setSelectionFrameOffset: (offset: number) => void;
  setSelectionRecommendations: (options: {
    fps?: number | null;
    resolution?: number | null;
    frameStep?: number | null;
    frameOffset?: number | null;
    maxTicks?: number | null;
  }) => void;
  clearSelectionRecommendations: () => void;
  exitSelectionMode: () => void;
}

function toPositiveIntegerOrNull(
  value: number | null | undefined,
): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value))
    : null;
}

function toPositiveInteger(
  value: number | null | undefined,
  fallback: number,
): number {
  return toPositiveIntegerOrNull(value) ?? fallback;
}

export const useTimelineSelectionStore = create<TimelineSelectionState>((set) => ({
  selectionMode: false,
  selectionStage: "range",
  selectionStartTick: 0,
  selectionEndTick: 0,
  selectionMessage: null,
  selectionIncludeModeEnabled: false,
  selectionAllowIncludeAll: false,
  selectionIncludedTrackIds: [],
  selectionFpsOverride: null,
  selectionResolutionOverride: null,
  selectionFrameStep: 1,
  selectionFrameOffset: 1,
  selectionRecommendedFps: null,
  selectionRecommendedResolution: null,
  selectionRecommendedFrameStep: null,
  selectionRecommendedFrameOffset: null,
  selectionRecommendedMaxTicks: null,
  enterSelectionMode: (startTick, endTick, options) =>
    set({
      selectionMode: true,
      selectionStage: "range",
      selectionStartTick: startTick,
      selectionEndTick: endTick,
      selectionMessage:
        typeof options?.message === "string" && options.message.trim().length > 0
          ? options.message.trim()
          : null,
      selectionFrameStep: toPositiveInteger(options?.frameStep, 1),
      selectionFrameOffset: toPositiveInteger(options?.frameOffset, 1),
      selectionFpsOverride: toPositiveIntegerOrNull(options?.fpsOverride),
      // Held to the offered rungs here for the same reason the setter is: a
      // short edge the project config would reject must not reach a render.
      selectionResolutionOverride: isProjectOutputResolution(
        options?.resolutionOverride,
      )
        ? options.resolutionOverride
        : null,
      selectionIncludeModeEnabled: options?.includeTracks === true,
      selectionAllowIncludeAll:
        options?.includeTracks === true && options?.allowIncludeAll === true,
      selectionIncludedTrackIds:
        options?.includeTracks === true && Array.isArray(options?.includedTrackIds)
        ? options.includedTrackIds.filter(
            (trackId, index, list): trackId is string =>
              typeof trackId === "string" &&
              trackId.trim().length > 0 &&
              list.indexOf(trackId) === index,
          )
        : [],
    }),
  updateSelectionStart: (tick) => set({ selectionStartTick: tick }),
  updateSelectionEnd: (tick) => set({ selectionEndTick: tick }),
  setSelectionMessage: (message) =>
    set({
      selectionMessage:
        typeof message === "string" && message.trim().length > 0
          ? message.trim()
          : null,
    }),
  enterTrackSelectionStage: () =>
    set((state) =>
      state.selectionIncludeModeEnabled
        ? { selectionStage: "tracks" }
        : {},
    ),
  returnToRangeSelectionStage: () => set({ selectionStage: "range" }),
  toggleSelectionIncludedTrack: (trackId) =>
    set((state) => {
      const normalizedTrackId = trackId.trim();
      if (!normalizedTrackId) {
        return {};
      }
      const hasTrack = state.selectionIncludedTrackIds.includes(normalizedTrackId);
      return {
        selectionIncludedTrackIds: hasTrack
          ? state.selectionIncludedTrackIds.filter((id) => id !== normalizedTrackId)
          : [...state.selectionIncludedTrackIds, normalizedTrackId],
      };
    }),
  includeAllSelectionTracks: (trackIds) =>
    set((state) => {
      if (!state.selectionIncludeModeEnabled || !state.selectionAllowIncludeAll) {
        return {};
      }
      return {
        selectionIncludedTrackIds: trackIds.filter(
          (trackId, index, list): trackId is string =>
            typeof trackId === "string" &&
            trackId.trim().length > 0 &&
            list.indexOf(trackId) === index,
        ),
      };
    }),
  setSelectionFpsOverride: (fps) =>
    set({ selectionFpsOverride: toPositiveIntegerOrNull(fps) }),
  setSelectionResolutionOverride: (resolution) =>
    set({
      // Only the offered rungs are storable: an arbitrary short edge would be
      // accepted here and then rejected by the project config it falls back
      // to, so the two would disagree about what the selection renders at.
      selectionResolutionOverride: isProjectOutputResolution(resolution)
        ? resolution
        : null,
    }),
  setSelectionFrameStep: (step) =>
    set({ selectionFrameStep: toPositiveInteger(step, 1) }),
  setSelectionFrameOffset: (offset) =>
    set({ selectionFrameOffset: toPositiveInteger(offset, 1) }),
  setSelectionRecommendations: ({
    fps,
    resolution,
    frameStep,
    frameOffset,
    maxTicks,
  }) =>
    set({
      // Unlike the override this is not restricted to the offered rungs: a
      // workflow's declared target is whatever its rules say, and rounding it
      // would defeat rendering at the size the workflow will actually use.
      selectionRecommendedResolution:
        typeof resolution === "number" &&
        Number.isFinite(resolution) &&
        resolution > 0
          ? Math.round(resolution)
          : null,
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
      selectionRecommendedFrameOffset:
        typeof frameOffset === "number" &&
        Number.isFinite(frameOffset) &&
        frameOffset > 0
          ? Math.max(1, Math.round(frameOffset))
          : null,
      selectionRecommendedMaxTicks:
        typeof maxTicks === "number" && Number.isFinite(maxTicks) && maxTicks > 0
          ? maxTicks
          : null,
    }),
  clearSelectionRecommendations: () =>
    set({
      selectionRecommendedResolution: null,
      selectionRecommendedFps: null,
      selectionRecommendedFrameStep: null,
      selectionRecommendedFrameOffset: null,
      selectionRecommendedMaxTicks: null,
    }),
  exitSelectionMode: () =>
    set({
      selectionMode: false,
      selectionStage: "range",
      selectionStartTick: 0,
      selectionEndTick: 0,
      selectionMessage: null,
      selectionIncludeModeEnabled: false,
      selectionAllowIncludeAll: false,
      selectionIncludedTrackIds: [],
      // The grid, fps and resolution belong to the selection that just ended,
      // exactly like the recommendations below. Leaving them behind is what
      // made a plain extraction inherit the previous workflow's settings.
      selectionFrameStep: 1,
      selectionFrameOffset: 1,
      selectionFpsOverride: null,
      selectionResolutionOverride: null,
      selectionRecommendedResolution: null,
      selectionRecommendedFps: null,
      selectionRecommendedFrameStep: null,
      selectionRecommendedFrameOffset: null,
      selectionRecommendedMaxTicks: null,
    }),
}));

/** Canonical Zustand identity exposed only through the trusted host directory. */
export function getTimelineSelectionStoreForTrustedHostAccess(): typeof useTimelineSelectionStore {
  return useTimelineSelectionStore;
}
