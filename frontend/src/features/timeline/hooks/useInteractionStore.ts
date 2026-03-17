// hooks/useInteractionStore.ts
import { create } from "zustand";
import type { BaseClip } from "../../../types/TimelineTypes";
import { useTimelineStore } from "../useTimelineStore";

export type InteractionOperation = "move" | "resize_left" | "resize_right";

type SnapPreview = {
  tick: number;
  snappedStartTicks?: number | null;
} | null;

interface InteractionState {
  activeClip: BaseClip | null;
  activeId: string | null;
  operation: InteractionOperation | null;
  currentDeltaX: number;
  currentDeltaY: number;

  // NEW: Track if we are visually "over" the timeline area
  isOverTimeline: boolean;

  // NEW: Store allowed pixel movement range
  constraints: { minPx: number; maxPx: number } | null;

  // NEW: Store the projected end time (ticks) of the operation
  // This helps the timeline expand during drag
  projectedEndTime: number | null;

  snappingEnabled: boolean;
  snapPoints: number[];
  snapTick: number | null;
  snappedStartTicks: number | null;

  startDrag: (
    id: string,
    clip: BaseClip,
    operation: InteractionOperation,
    constraints?: { minPx: number; maxPx: number } | null,
  ) => void;
  updateDelta: (deltaX: number, deltaY?: number) => void;
  // NEW
  setIsOverTimeline: (isOver: boolean) => void;
  updateProjectedEndTime: (time: number | null) => void;
  toggleSnappingEnabled: () => void;
  setSnapPreview: (preview: SnapPreview) => void;
  clearSnapPreview: () => void;
  stopDrag: () => void;
}

const buildSnapPoints = (clip: BaseClip, operation: InteractionOperation) => {
  const { clips, selectedClipIds } = useTimelineStore.getState();
  const excludedIds = new Set<string>();

  if (operation === "move" && "trackId" in clip) {
    if (selectedClipIds.includes(clip.id)) {
      selectedClipIds.forEach((id) => excludedIds.add(id));
    } else {
      excludedIds.add(clip.id);
    }
  } else if (operation === "resize_left" || operation === "resize_right") {
    excludedIds.add(clip.id);
  }

  const points = new Set<number>();
  clips.forEach((timelineClip) => {
    if (timelineClip.type === "mask") return;
    if (excludedIds.has(timelineClip.id)) return;
    points.add(Math.round(timelineClip.start));
    points.add(Math.round(timelineClip.start + timelineClip.timelineDuration));
  });

  return [...points].sort((a, b) => a - b);
};

export const useInteractionStore = create<InteractionState>((set) => ({
  activeClip: null,
  activeId: null,
  operation: null,
  currentDeltaX: 0,
  currentDeltaY: 0,
  isOverTimeline: false,
  constraints: null,
  projectedEndTime: null,
  snappingEnabled: true,
  snapPoints: [],
  snapTick: null,
  snappedStartTicks: null,

  startDrag: (id, clip, operation, constraints = null) =>
    set({
      activeId: id,
      activeClip: clip,
      operation,
      currentDeltaX: 0,
      currentDeltaY: 0,
      isOverTimeline: false,
      constraints,
      projectedEndTime: null,
      snapPoints: buildSnapPoints(clip, operation),
      snapTick: null,
      snappedStartTicks: null,
    }),

  updateDelta: (deltaX, deltaY = 0) =>
    set({ currentDeltaX: deltaX, currentDeltaY: deltaY }),

  setIsOverTimeline: (isOver) => set({ isOverTimeline: isOver }),
  updateProjectedEndTime: (time) => set({ projectedEndTime: time }),
  toggleSnappingEnabled: () =>
    set((state) => ({
      snappingEnabled: !state.snappingEnabled,
      snapTick: null,
      snappedStartTicks: null,
    })),
  setSnapPreview: (preview) =>
    set((state) => {
      if (preview === null) {
        if (state.snapTick === null && state.snappedStartTicks === null) {
          return state;
        }
        return {
          snapTick: null,
          snappedStartTicks: null,
        };
      }

      const nextTick = preview.tick;
      const nextStart = preview.snappedStartTicks ?? null;

      if (
        state.snapTick === nextTick &&
        state.snappedStartTicks === nextStart
      ) {
        return state;
      }

      return {
        snapTick: nextTick,
        snappedStartTicks: nextStart,
      };
    }),
  clearSnapPreview: () =>
    set((state) => {
      if (state.snapTick === null && state.snappedStartTicks === null) {
        return state;
      }
      return {
        snapTick: null,
        snappedStartTicks: null,
      };
    }),

  stopDrag: () =>
    set({
      activeClip: null,
      activeId: null,
      operation: null,
      currentDeltaX: 0,
      currentDeltaY: 0,
      isOverTimeline: false,
      constraints: null,
      projectedEndTime: null,
      snapPoints: [],
      snapTick: null,
      snappedStartTicks: null,
    }),
}));
