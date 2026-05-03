import { useCallback, useMemo } from "react";
import type {
  MaskActiveRange,
  MaskTimelineClip,
  StandardTimelineClip,
} from "../../../types/TimelineTypes";
import type { RangeMaskComponent } from "../../../types/Components";
import { TICKS_PER_SECOND, useTimelineStore } from "../../timeline";
import { useTimelineSelectionStore } from "../../timelineSelection";
import { useExtractStore } from "../../player/useExtractStore";
import { playbackClock } from "../../player/services/PlaybackClock";
import { mapSourceTimeToVisualTime } from "../../transformations";
import { toClipInputTimeTicks } from "../utils/clipTime";

interface UpdateClipMaskFn {
  (
    clipId: string,
    maskId: string,
    updates: {
      activeRange?: MaskActiveRange | null;
    },
  ): void;
}

interface UseRangeMaskSelectionArgs {
  selectedClipId: string | null;
  standardSelectedClip: StandardTimelineClip | null;
  selectedMaskId: string | null;
  selectedMask: MaskTimelineClip | null;
  updateClipMask: UpdateClipMaskFn;
}

export interface UseRangeMaskSelectionResult {
  rangeMaskComponents: RangeMaskComponent[];
  startAddRangeMask: () => void;
  startEditRangeMask: (rangeMaskId: string) => void;
  removeRangeMask: (rangeMaskId: string) => void;
  toggleRangeMaskActive: (rangeMaskId: string) => void;
  selectedMaskActiveRange: MaskActiveRange | null;
  startSetSelectedMaskActiveRange: () => void;
  clearSelectedMaskActiveRange: () => void;
}

export function useRangeMaskSelection({
  selectedClipId,
  standardSelectedClip,
  selectedMaskId,
  selectedMask,
  updateClipMask,
}: UseRangeMaskSelectionArgs): UseRangeMaskSelectionResult {
  const addClipComponent = useTimelineStore((state) => state.addClipComponent);
  const updateClipComponent = useTimelineStore(
    (state) => state.updateClipComponent,
  );
  const removeClipComponent = useTimelineStore(
    (state) => state.removeClipComponent,
  );

  const rangeMaskComponents = useMemo<RangeMaskComponent[]>(
    () =>
      (standardSelectedClip?.components ?? []).filter(
        (component): component is RangeMaskComponent =>
          component.type === "range_mask",
      ),
    [standardSelectedClip],
  );

  const beginClipSelection = useCallback(
    (
      clip: StandardTimelineClip,
      seededStart: number,
      seededEnd: number,
      onCommit: (startSourceTicks: number, endSourceTicks: number) => void,
    ) => {
      const selectionStore = useTimelineSelectionStore.getState();
      const extractStore = useExtractStore.getState();

      selectionStore.clearSelectionRecommendations();
      selectionStore.enterSelectionMode(seededStart, seededEnd);

      extractStore.setOnConfirmSelection(() => {
        const { selectionStartTick, selectionEndTick } =
          useTimelineSelectionStore.getState();
        const startSourceTicks = toClipInputTimeTicks(clip, selectionStartTick);
        const endSourceTicks = toClipInputTimeTicks(clip, selectionEndTick);
        const orderedStart = Math.min(startSourceTicks, endSourceTicks);
        const orderedEnd = Math.max(startSourceTicks, endSourceTicks);

        onCommit(orderedStart, orderedEnd);

        useTimelineSelectionStore.getState().exitSelectionMode();
        useExtractStore.getState().setOnConfirmSelection(null);
      });
    },
    [],
  );

  const startAddRangeMask = useCallback(() => {
    if (!selectedClipId || !standardSelectedClip) return;

    const clip = standardSelectedClip;
    const clipStart = clip.start;
    const clipEnd = clip.start + clip.timelineDuration;
    const defaultStart = Math.max(
      clipStart,
      Math.min(playbackClock.time, clipEnd),
    );
    const defaultEnd = Math.min(clipEnd, defaultStart + TICKS_PER_SECOND);

    beginClipSelection(clip, defaultStart, defaultEnd, (startSourceTicks, endSourceTicks) => {
      const newComponent: RangeMaskComponent = {
        id: `range_${crypto.randomUUID()}`,
        type: "range_mask",
        parameters: {
          startSourceTicks,
          endSourceTicks,
          isActive: true,
        },
      };
      addClipComponent(selectedClipId, newComponent);
    });
  }, [addClipComponent, beginClipSelection, selectedClipId, standardSelectedClip]);

  const startEditRangeMask = useCallback(
    (rangeMaskId: string) => {
      if (!selectedClipId || !standardSelectedClip) return;

      const clip = standardSelectedClip;
      const existing = (clip.components ?? []).find(
        (component): component is RangeMaskComponent =>
          component.id === rangeMaskId && component.type === "range_mask",
      );
      if (!existing) return;

      const clipStart = clip.start;
      const clipEnd = clip.start + clip.timelineDuration;
      const rawStart =
        clipStart +
        mapSourceTimeToVisualTime(clip, existing.parameters.startSourceTicks);
      const rawEnd =
        clipStart +
        mapSourceTimeToVisualTime(clip, existing.parameters.endSourceTicks);
      const seededStart = Math.max(clipStart, Math.min(rawStart, clipEnd));
      const seededEnd = Math.max(clipStart, Math.min(rawEnd, clipEnd));

      beginClipSelection(clip, seededStart, seededEnd, (startSourceTicks, endSourceTicks) => {
        updateClipComponent(selectedClipId, rangeMaskId, (component) => {
          if (component.type !== "range_mask") return component;
          return {
            ...component,
            parameters: {
              ...component.parameters,
              startSourceTicks,
              endSourceTicks,
            },
          };
        });
      });
    },
    [beginClipSelection, selectedClipId, standardSelectedClip, updateClipComponent],
  );

  const removeRangeMask = useCallback(
    (rangeMaskId: string) => {
      if (!selectedClipId) return;
      removeClipComponent(selectedClipId, rangeMaskId);
    },
    [removeClipComponent, selectedClipId],
  );

  const toggleRangeMaskActive = useCallback(
    (rangeMaskId: string) => {
      if (!selectedClipId) return;
      updateClipComponent(selectedClipId, rangeMaskId, (component) => {
        if (component.type !== "range_mask") return component;
        return {
          ...component,
          parameters: {
            ...component.parameters,
            isActive: !component.parameters.isActive,
          },
        };
      });
    },
    [selectedClipId, updateClipComponent],
  );

  const selectedMaskActiveRange = useMemo<MaskActiveRange | null>(() => {
    return selectedMask?.activeRange ?? null;
  }, [selectedMask]);

  const startSetSelectedMaskActiveRange = useCallback(() => {
    if (!selectedClipId || !selectedMaskId || !standardSelectedClip || !selectedMask) {
      return;
    }

    const clip = standardSelectedClip;
    const clipStart = clip.start;
    const clipEnd = clip.start + clip.timelineDuration;

    let seededStart: number;
    let seededEnd: number;
    if (selectedMaskActiveRange) {
      const rawStart =
        clipStart +
        mapSourceTimeToVisualTime(
          clip,
          selectedMaskActiveRange.startSourceTicks,
        );
      const rawEnd =
        clipStart +
        mapSourceTimeToVisualTime(clip, selectedMaskActiveRange.endSourceTicks);
      seededStart = Math.max(clipStart, Math.min(rawStart, clipEnd));
      seededEnd = Math.max(clipStart, Math.min(rawEnd, clipEnd));
    } else {
      seededStart = Math.max(
        clipStart,
        Math.min(playbackClock.time, clipEnd),
      );
      seededEnd = Math.min(clipEnd, seededStart + TICKS_PER_SECOND);
    }

    beginClipSelection(clip, seededStart, seededEnd, (startSourceTicks, endSourceTicks) => {
      updateClipMask(selectedClipId, selectedMaskId, {
        activeRange: {
          startSourceTicks,
          endSourceTicks,
        },
      });
    });
  }, [
    beginClipSelection,
    selectedClipId,
    selectedMask,
    selectedMaskActiveRange,
    selectedMaskId,
    standardSelectedClip,
    updateClipMask,
  ]);

  const clearSelectedMaskActiveRange = useCallback(() => {
    if (!selectedClipId || !selectedMaskId) return;
    updateClipMask(selectedClipId, selectedMaskId, { activeRange: null });
  }, [selectedClipId, selectedMaskId, updateClipMask]);

  return {
    rangeMaskComponents,
    startAddRangeMask,
    startEditRangeMask,
    removeRangeMask,
    toggleRangeMaskActive,
    selectedMaskActiveRange,
    startSetSelectedMaskActiveRange,
    clearSelectedMaskActiveRange,
  };
}
