import { useCallback, useRef } from "react";
import type {
  DragStartEvent,
  DragEndEvent,
  DragMoveEvent,
} from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import { useTimelineStore } from "../../useTimelineStore";
import { useInteractionStore } from "../useInteractionStore";
import { useClipMove } from "./useClipMove";
import type { BaseClip } from "../../../../types/TimelineTypes";
import type { Asset, AssetType } from "../../../../types/Asset";
import { assetMatchesType } from "../../../../shared/utils/assetTypeDetection";

/** Final pointer viewport position of a drag, reconstructed from the
 * activator event plus the accumulated drag delta. */
function getDropPointerPosition(
  event: DragEndEvent,
): { clientX: number; clientY: number } | null {
  const coordinates = event.activatorEvent
    ? getEventCoordinates(event.activatorEvent)
    : null;
  if (!coordinates) return null;
  return {
    clientX: coordinates.x + event.delta.x,
    clientY: coordinates.y + event.delta.y,
  };
}

export const useAssetDrag = () => {
  // We need a ref to the scroll container for coordinate calculations (drops)
  // This ref should be passed down to the TimelineContainer
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const moveStrategy = useClipMove(scrollContainerRef, "external");

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const { active } = event;
      const data = active.data.current;

      if (!data || data.type !== "asset") return;

      // 1. Deselect timeline clips to avoid confusion
      useTimelineStore.getState().selectClip(null);

      // 2. Clone and Assign UNIQUE ID
      // Critical: AssetCard is memoized, so `data.clip` is stable.
      // We need a fresh ID for every new drag instance.
      const freshClip = {
        ...data.clip,
        id: `clip_${crypto.randomUUID()}`,
      } as BaseClip;

      useInteractionStore
        .getState()
        .startDrag(active.id as string, freshClip, "move");
    },
    [],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      // Asset drag mainly updates the interaction store via useClipMove's internal logic
      // or simply updates the overlay position which dnd-kit handles.
      // However, for "Gap Insertion" or "Snap", useClipMove needs the event.

      // This handles a race condition where the handleMove fires AFTER
      // the handleEnd has already cleaned up the interaction state.
      // This can lead to a lingering HoverGap Indicator
      const { operation } = useInteractionStore.getState();
      if (operation !== "move") return;

      useInteractionStore.getState().updateDelta(event.delta.x);
      moveStrategy.handleMove(event);
    },
    [moveStrategy],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const interaction = useInteractionStore.getState();
      const activeClip = interaction.activeClip;
      const snappedStartTicks = interaction.snappedStartTicks;
      const insertGapIndex = interaction.externalInsertGapIndex;
      const activeData = event.active.data.current;
      const overData = event.over?.data.current;

      // Always clean up interaction state first
      interaction.stopDrag();

      // Check for asset-slot drop (e.g. GenerationPanel input slots)
      if (overData?.type === "asset-slot") {
        if (activeData?.type === "asset" && overData.onDrop) {
          const asset = activeData.asset as Asset | undefined;
          if (
            asset &&
            (overData.accept as AssetType[]).some((acceptedType) =>
              assetMatchesType(asset, acceptedType),
            )
          ) {
            overData.onDrop(asset, getDropPointerPosition(event));
          }
          return;
        }

        if (
          activeData?.type === "media-input" &&
          typeof overData.onReorderDrop === "function"
        ) {
          overData.onReorderDrop(activeData);
        }
        return;
      }

      if (!activeClip) return;

      // Check if we effectively dropped "on" the timeline
      // The moveStrategy.handleEnd contains the logic to calculate coordinates
      // and decide if it was a valid drop.
      moveStrategy.handleEnd(
        event,
        activeClip as BaseClip,
        snappedStartTicks,
        insertGapIndex,
      );
    },
    [moveStrategy],
  );

  return {
    handleAssetDragStart: handleDragStart,
    handleAssetDragMove: handleDragMove,
    handleAssetDragEnd: handleDragEnd,
    scrollContainerRef,
  };
};
