import { useCallback, useRef } from "react";
import type {
  DragCancelEvent,
  DragEndEvent,
  DragMoveEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import { useProjectStore } from "../../project";
import {
  addTimelineAdjustmentClip,
  addTimelineClipTransform,
  getTimelineModelState,
  resolveCollision,
  selectTimelineClip,
} from "../../timeline";
import { RULER_HEIGHT, TRACK_HEADER_WIDTH } from "../../timeline/constants";
import {
  buildTimelineSnapPoints,
  useInteractionStore,
} from "../../timeline/hooks/useInteractionStore";
import { resolveTimelineDropTarget } from "../../timeline/hooks/dnd/dropGeometry";
import { usePointerTracker } from "../../timeline/hooks/dnd/usePointerTracker";
import { useTimelineViewStore } from "../../timeline/hooks/useTimelineViewStore";
import { getAssetById } from "../../userAssets";
import { isAssetBackedClip } from "../../../types/TimelineTypes";
import type {
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { getTicksPerFrame, snapTickToFrame } from "../../timelineSelection";
import {
  getEntryByFilterName,
  getEntryByType,
  isTransformCompatible,
} from "../catalogue/TransformationRegistry";
import type { TransformationDefinition } from "../catalogue/types";
import { createAddTransform } from "./controller/transformFactory";
import { findClipAtPoint } from "../utils/findClipAtPoint";
import type { TransformDragData } from "../components/library/TransformationCard";

/** Sentinel id for collision-resolving a not-yet-created adjustment clip. */
const NEW_ADJUSTMENT_CLIP_ID = "__transform_new_adjustment__";

/**
 * Geometry of a transform drop, resolved from the shared timeline drop kernel
 * (`resolveTimelineDropTarget`). The transform card anchors its footprint at
 * the cursor (ghostOffsetX = 0), so `hitTestTick` (the unsnapped cursor tick)
 * and `startTick` (the snapped footprint start) coincide unless clip-edge
 * snapping kicks in.
 */
interface DropGeometry {
  /** Track row under the cursor, or -1 when below the stack (append). */
  trackIndex: number;
  trackId: string | null;
  /** Insert gap from the shared kernel when near a boundary, else null. */
  interstitialGapIndex: number | null;
  /** Unsnapped cursor tick — used to hit-test the clip under the cursor. */
  hitTestTick: number;
  /** Frame- or clip-edge-snapped start tick for a placed footprint. */
  startTick: number;
  /** Matched snap point for the snap-line indicator, else null. */
  snapTick: number | null;
}

/**
 * Resolved intent for a transform drop. Computed identically for the move
 * (preview) and end (commit) phases so the ghost always matches the result.
 */
type DropPlacement =
  | { kind: "clip"; clip: TimelineClip; compatible: boolean }
  // Place a 5s clip on a lane (existing adjustment lane, or a freshly inserted
  // one). `trackIndex` is the row to draw the footprint at; exactly one of
  // `trackId` / `insertTrackIndex` resolves where the clip actually lands.
  | {
      kind: "lane";
      trackIndex: number;
      trackId: string | null;
      insertTrackIndex: number | null;
      startTick: number;
      durationTicks: number;
      compatible: boolean;
    }
  // Interstitial: insert a new adjustment track at a track boundary.
  | {
      kind: "interstitial";
      gapIndex: number;
      startTick: number;
      durationTicks: number;
      compatible: boolean;
    };

function isTransformDragData(data: unknown): data is TransformDragData {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as { type?: unknown }).type === "transform" &&
    typeof (data as { transformType?: unknown }).transformType === "string" &&
    typeof (data as { isFilter?: unknown }).isFilter === "boolean"
  );
}

function resolveDefinition(
  data: TransformDragData,
): TransformationDefinition | undefined {
  return data.isFilter
    ? getEntryByFilterName(data.transformType)
    : getEntryByType(data.transformType);
}

function getClipHasAudio(clip: TimelineClip): boolean | undefined {
  if (!isAssetBackedClip(clip)) {
    return undefined;
  }
  return getAssetById(clip.assetId)?.hasAudio;
}

function getFiveSecondsTicks(fps: number): number {
  const framesPerSecond = Math.max(1, Math.round(fps));
  return getTicksPerFrame(framesPerSecond) * framesPerSecond * 5;
}

/**
 * Decide what a drop resolves to, given the shared geometry. Single source of
 * truth for both the live preview and the commit:
 *
 * - Directly over a clip → add to that clip (compatibility checked).
 * - Below the stack → append a new adjustment track.
 * - Near a track boundary → interstitial: insert a NEW adjustment track.
 * - Middle of an adjustment lane → place a 5s clip on it, snapping around any
 *   clips already on the lane.
 * - Middle of a non-adjustment lane → create a new adjustment track at the row.
 */
function resolveDropPlacement(
  geom: DropGeometry,
  definition: TransformationDefinition,
  model: { clips: TimelineClip[]; tracks: TimelineTrack[] },
  fps: number,
  durationTicks: number,
): DropPlacement {
  const { clips, tracks } = model;

  // 1. Directly over a clip → add to the clip's stack.
  if (geom.trackId !== null) {
    const clip = findClipAtPoint({
      tracks,
      clips,
      fps,
      trackId: geom.trackId,
      tick: geom.hitTestTick,
    });
    if (clip) {
      return {
        kind: "clip",
        clip,
        compatible: isTransformCompatible(
          definition,
          clip.type,
          getClipHasAudio(clip),
        ),
      };
    }
  }

  // Empty-area placements only make sense for adjustment-capable transforms.
  const adjustmentCompatible = definition.adjustmentCompatible === true;

  // 2. Below the stack → append a new adjustment track, footprint on the row
  //    just below the current stack.
  if (geom.trackIndex === -1) {
    return {
      kind: "lane",
      trackIndex: tracks.length,
      trackId: null,
      insertTrackIndex: tracks.length,
      startTick: geom.startTick,
      durationTicks,
      compatible: adjustmentCompatible,
    };
  }

  // 3. Boundary zone → genuine interstitial: insert a new adjustment track at
  //    the boundary. Shown as a gap line only (no footprint rectangle).
  if (geom.interstitialGapIndex !== null) {
    return {
      kind: "interstitial",
      gapIndex: geom.interstitialGapIndex,
      startTick: geom.startTick,
      durationTicks,
      compatible: adjustmentCompatible,
    };
  }

  // 4. Middle of an existing adjustment lane → place on it, snapping around any
  //    clips already on the lane. Shown as a footprint rectangle.
  const track = tracks[geom.trackIndex];
  if (track?.type === "adjustment") {
    const resolvedStart = resolveCollision(
      NEW_ADJUSTMENT_CLIP_ID,
      geom.startTick,
      durationTicks,
      track.id,
      clips,
    );
    return {
      kind: "lane",
      trackIndex: geom.trackIndex,
      trackId: track.id,
      insertTrackIndex: null,
      startTick: resolvedStart ?? geom.startTick,
      durationTicks,
      // A null resolution means the clip can't fit anywhere near the drop —
      // surface it as incompatible so the ghost reads red and the drop no-ops.
      compatible: adjustmentCompatible && resolvedStart !== null,
    };
  }

  // 5. Middle of a non-adjustment lane → create a new adjustment track at this
  //    row. Shown as a footprint rectangle at the cursor row (no gap line).
  return {
    kind: "lane",
    trackIndex: geom.trackIndex,
    trackId: null,
    insertTrackIndex: geom.trackIndex,
    startTick: geom.startTick,
    durationTicks,
    compatible: adjustmentCompatible,
  };
}

export function useTransformDrag(
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
) {
  const cursorRef = usePointerTracker();
  // Snap points are clip edges / markers; they don't change mid-drag, so we
  // build them once at drag start (matching the asset-move flow).
  const snapPointsRef = useRef<number[]>([]);

  const computeDrop = useCallback(
    (
      data: TransformDragData,
    ): { placement: DropPlacement; geom: DropGeometry } | null => {
      const container = scrollContainerRef.current;
      const cursor = cursorRef.current;
      if (!container || !cursor) {
        return null;
      }

      const rect = container.getBoundingClientRect();
      if (
        cursor.x < rect.left ||
        cursor.x > rect.right ||
        cursor.y < rect.top ||
        cursor.y > rect.bottom
      ) {
        return null;
      }

      const scrollLeft = container.scrollLeft;
      const scrollTop = container.scrollTop;
      // Over the track headers or the ruler is not a valid timeline drop.
      if (cursor.x - rect.left + scrollLeft - TRACK_HEADER_WIDTH < 0) {
        return null;
      }
      if (cursor.y - rect.top + scrollTop - RULER_HEIGHT < 0) {
        return null;
      }

      const definition = resolveDefinition(data);
      if (!definition) {
        return null;
      }

      const { clips, tracks } = getTimelineModelState();
      const fps = useProjectStore.getState().config.fps;
      const view = useTimelineViewStore.getState();
      const interaction = useInteractionStore.getState();
      const durationTicks = getFiveSecondsTicks(fps);

      const target = resolveTimelineDropTarget({
        cursorX: cursor.x,
        cursorY: cursor.y,
        containerLeftPx: rect.left,
        containerTopPx: rect.top,
        containerBottomPx: rect.bottom,
        scrollLeft,
        scrollTop,
        trackCount: tracks.length,
        ghostDurationTicks: durationTicks,
        // Anchor the footprint's left edge at the cursor (no asset grab offset).
        ghostOffsetX: 0,
        ticksToPx: view.ticksToPx,
        pxToTicks: view.pxToTicks,
        snap: {
          points: snapPointsRef.current,
          enabled: interaction.snappingEnabled,
        },
      });

      const ticksPerFrame = getTicksPerFrame(fps);
      const startTick =
        target.snappedStartTicks != null
          ? target.snappedStartTicks
          : Math.max(0, snapTickToFrame(target.rawStartTicks, ticksPerFrame));
      const trackId =
        target.trackIndex >= 0 && target.trackIndex < tracks.length
          ? tracks[target.trackIndex].id
          : null;

      const geom: DropGeometry = {
        trackIndex: target.trackIndex,
        trackId,
        interstitialGapIndex: target.interstitialGapIndex,
        hitTestTick: target.rawStartTicks,
        startTick,
        snapTick: target.snapTick,
      };

      const placement = resolveDropPlacement(
        geom,
        definition,
        { clips, tracks },
        fps,
        durationTicks,
      );
      return { placement, geom };
    },
    [scrollContainerRef, cursorRef],
  );

  const handleTransformDragStart = useCallback((event: DragStartEvent) => {
    if (!isTransformDragData(event.active.data.current)) {
      return;
    }

    snapPointsRef.current = buildTimelineSnapPoints({});
    const interaction = useInteractionStore.getState();
    interaction.clearTransformDropPreview();
    interaction.clearSnapPreview();
    interaction.updateProjectedEndTime(null);
  }, []);

  const handleTransformDragMove = useCallback(
    (event: DragMoveEvent) => {
      const data = event.active.data.current;
      if (!isTransformDragData(data)) {
        return;
      }

      const result = computeDrop(data);
      const interaction = useInteractionStore.getState();
      interaction.setIsOverTimeline(result !== null);

      if (!result) {
        interaction.clearTransformDropPreview();
        interaction.clearSnapPreview();
        interaction.updateProjectedEndTime(null);
        return;
      }

      const { placement, geom } = result;

      if (placement.kind === "clip") {
        interaction.setTransformDropPreview({
          kind: "clip",
          clipId: placement.clip.id,
          compatible: placement.compatible,
        });
        // Adding to an existing clip — snapping / expansion don't apply.
        interaction.clearSnapPreview();
        interaction.updateProjectedEndTime(null);
        return;
      }

      if (placement.kind === "interstitial") {
        interaction.setTransformDropPreview({
          kind: "gap",
          gapIndex: placement.gapIndex,
          compatible: placement.compatible,
        });
      } else {
        interaction.setTransformDropPreview({
          kind: "rect",
          trackIndex: placement.trackIndex,
          startTick: placement.startTick,
          durationTicks: placement.durationTicks,
          compatible: placement.compatible,
        });
      }

      // Drive the shared snap-line indicator when a clip edge was matched.
      if (geom.snapTick !== null) {
        interaction.setSnapPreview({
          tick: geom.snapTick,
          snappedStartTicks: placement.startTick,
        });
      } else {
        interaction.clearSnapPreview();
      }

      // Let the timeline expand if the footprint runs past current content.
      interaction.updateProjectedEndTime(
        placement.startTick + placement.durationTicks,
      );
    },
    [computeDrop],
  );

  const handleTransformDragEnd = useCallback(
    (event: DragEndEvent) => {
      const data = event.active.data.current;
      const result = isTransformDragData(data) ? computeDrop(data) : null;

      const interaction = useInteractionStore.getState();
      interaction.clearTransformDropPreview();
      interaction.clearSnapPreview();
      interaction.updateProjectedEndTime(null);
      interaction.setIsOverTimeline(false);
      snapPointsRef.current = [];

      if (!isTransformDragData(data) || !result || !result.placement.compatible) {
        return;
      }

      const { placement } = result;
      const transform = createAddTransform(data.transformType, data.isFilter);
      if (!transform) {
        return;
      }

      if (placement.kind === "clip") {
        addTimelineClipTransform(placement.clip.id, transform);
        selectTimelineClip(placement.clip.id);
        return;
      }

      const adjustmentClipId =
        placement.kind === "interstitial"
          ? addTimelineAdjustmentClip({
              insertTrackIndex: placement.gapIndex,
              start: placement.startTick,
              timelineDuration: placement.durationTicks,
            })
          : placement.trackId !== null
            ? addTimelineAdjustmentClip({
                trackId: placement.trackId,
                start: placement.startTick,
                timelineDuration: placement.durationTicks,
              })
            : addTimelineAdjustmentClip({
                insertTrackIndex: placement.insertTrackIndex ?? undefined,
                start: placement.startTick,
                timelineDuration: placement.durationTicks,
              });

      if (!adjustmentClipId) {
        return;
      }

      addTimelineClipTransform(adjustmentClipId, transform);
      selectTimelineClip(adjustmentClipId);
    },
    [computeDrop],
  );

  const handleTransformDragCancel = useCallback((_event: DragCancelEvent) => {
    const interaction = useInteractionStore.getState();
    interaction.clearTransformDropPreview();
    interaction.clearSnapPreview();
    interaction.updateProjectedEndTime(null);
    interaction.setIsOverTimeline(false);
    snapPointsRef.current = [];
  }, []);

  return {
    handleTransformDragStart,
    handleTransformDragMove,
    handleTransformDragEnd,
    handleTransformDragCancel,
  };
}
