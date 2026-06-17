// hooks/useInteractionStore.ts
import { create } from "zustand";
import type { BaseClip } from "../../../types/TimelineTypes";
import { useTimelineStore } from "../useTimelineStore";
import { useProjectStore } from "../../project/useProjectStore";
import { mapSourceTimeToVisualTime } from "../../transformations";
import {
  buildTimelineClipPresentationIndex,
  resolvePresentationTickForClipOffset,
  resolvePresentationOffsetForClipOffset,
} from "../utils/clipPresentation";

export type InteractionOperation = "move" | "resize_left" | "resize_right";

interface BuildTimelineSnapPointsOptions {
  excludedClipIds?: Iterable<string>;
}

type SnapPreview = {
  tick: number;
  snappedStartTicks?: number | null;
} | null;

export type TransformDropPreview =
  // Hovering an existing clip — the clip itself is outlined.
  | {
      kind: "clip";
      clipId: string;
      compatible: boolean;
    }
  // A 5s adjustment clip will be placed at this row/tick — show its footprint.
  | {
      kind: "rect";
      trackIndex: number;
      startTick: number;
      durationTicks: number;
      compatible: boolean;
    }
  // A new adjustment track will be inserted between tracks — show a gap line.
  | {
      kind: "gap";
      gapIndex: number;
      compatible: boolean;
    };

interface InteractionState {
  activeClip: BaseClip | null;
  activeId: string | null;
  operation: InteractionOperation | null;
  currentDeltaX: number;
  currentDeltaY: number;
  externalInsertGapIndex: number | null;

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
  transformDropPreview: TransformDropPreview | null;

  startDrag: (
    id: string,
    clip: BaseClip,
    operation: InteractionOperation,
    constraints?: { minPx: number; maxPx: number } | null,
  ) => void;
  updateDelta: (deltaX: number, deltaY?: number) => void;
  // NEW
  setIsOverTimeline: (isOver: boolean) => void;
  setExternalInsertGapIndex: (index: number | null) => void;
  updateProjectedEndTime: (time: number | null) => void;
  toggleSnappingEnabled: () => void;
  setSnapPreview: (preview: SnapPreview) => void;
  clearSnapPreview: () => void;
  setTransformDropPreview: (preview: TransformDropPreview | null) => void;
  clearTransformDropPreview: () => void;
  stopDrag: () => void;
}

export const buildTimelineSnapPoints = (
  options: BuildTimelineSnapPointsOptions = {},
) => {
  const excludedIds = new Set(options.excludedClipIds ?? []);
  const { clips, tracks } = useTimelineStore.getState();
  const fps = useProjectStore.getState().config.fps;
  const presentationByClipId = buildTimelineClipPresentationIndex(
    tracks,
    clips,
    fps,
  );

  const points = new Set<number>();
  clips.forEach((timelineClip) => {
    if (timelineClip.type === "mask") return;
    if (excludedIds.has(timelineClip.id)) return;
    const presentation = presentationByClipId.get(timelineClip.id);
    points.add(Math.round(presentation?.start ?? timelineClip.start));
    points.add(
      Math.round(
        presentation?.end ?? timelineClip.start + timelineClip.timelineDuration,
      ),
    );

    const components = timelineClip.components ?? [];
    components.forEach((component) => {
      if (component.type !== "markers") return;
      if (component.isEnabled === false) return;
      component.parameters.markers.forEach((marker) => {
        const visualTicks = mapSourceTimeToVisualTime(
          timelineClip,
          marker.sourceTimeTicks,
        );
        if (visualTicks < 0 || visualTicks > timelineClip.timelineDuration) {
          return;
        }
        const presentationOffset = resolvePresentationOffsetForClipOffset(
          presentation,
          visualTicks,
        );
        const presentationDuration =
          presentation?.duration ?? timelineClip.timelineDuration;
        if (
          presentationOffset < 0 ||
          presentationOffset > presentationDuration
        ) {
          return;
        }
        points.add(
          Math.round(
            resolvePresentationTickForClipOffset(
              timelineClip,
              presentation,
              visualTicks,
            ),
          ),
        );
      });
    });
  });

  return [...points].sort((a, b) => a - b);
};

const buildSnapPoints = (clip: BaseClip, operation: InteractionOperation) => {
  const { selectedClipIds } = useTimelineStore.getState();
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

  return buildTimelineSnapPoints({ excludedClipIds: excludedIds });
};

export const useInteractionStore = create<InteractionState>((set) => ({
  activeClip: null,
  activeId: null,
  operation: null,
  currentDeltaX: 0,
  currentDeltaY: 0,
  externalInsertGapIndex: null,
  isOverTimeline: false,
  constraints: null,
  projectedEndTime: null,
  snappingEnabled: true,
  snapPoints: [],
  snapTick: null,
  snappedStartTicks: null,
  transformDropPreview: null,

  startDrag: (id, clip, operation, constraints = null) =>
    set({
      activeId: id,
      activeClip: clip,
      operation,
      currentDeltaX: 0,
      currentDeltaY: 0,
      externalInsertGapIndex: null,
      isOverTimeline: false,
      constraints,
      projectedEndTime: null,
      snapPoints: buildSnapPoints(clip, operation),
      snapTick: null,
      snappedStartTicks: null,
      transformDropPreview: null,
    }),

  updateDelta: (deltaX, deltaY = 0) =>
    set({ currentDeltaX: deltaX, currentDeltaY: deltaY }),

  setIsOverTimeline: (isOver) => set({ isOverTimeline: isOver }),
  setExternalInsertGapIndex: (index) => set({ externalInsertGapIndex: index }),
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
  setTransformDropPreview: (preview) => set({ transformDropPreview: preview }),
  clearTransformDropPreview: () =>
    set((state) => {
      if (state.transformDropPreview === null) {
        return state;
      }
      return { transformDropPreview: null };
    }),

  stopDrag: () =>
    set({
      activeClip: null,
      activeId: null,
      operation: null,
      currentDeltaX: 0,
      currentDeltaY: 0,
      externalInsertGapIndex: null,
      isOverTimeline: false,
      constraints: null,
      projectedEndTime: null,
      snapPoints: [],
      snapTick: null,
      snappedStartTicks: null,
      transformDropPreview: null,
    }),
}));
