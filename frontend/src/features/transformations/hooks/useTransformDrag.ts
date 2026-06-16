import { useCallback, useEffect, useRef } from "react";
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
import {
  RULER_HEIGHT,
  TRACK_HEADER_WIDTH,
  TRACK_HEIGHT,
} from "../../timeline/constants";
import { useInteractionStore } from "../../timeline/hooks/useInteractionStore";
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

/**
 * Fraction of a track's height (top & bottom) that triggers an interstitial
 * "insert a new track" drop, mirroring the asset-drag gap logic in
 * `useClipMove`. The middle band drops onto the lane itself.
 */
const INTERSTITIAL_ZONE_RATIO = 0.35;

/** Sentinel id for collision-resolving a not-yet-created adjustment clip. */
const NEW_ADJUSTMENT_CLIP_ID = "__transform_new_adjustment__";

interface TimelineDropPoint {
  /** Track id under the cursor, or null when past the end of the stack. */
  trackId: string | null;
  trackIndex: number;
  /** Vertical offset within the hovered track row, in px. */
  withinTrackY: number;
  tick: number;
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

function getZone(withinTrackY: number): "top" | "middle" | "bottom" {
  if (withinTrackY < TRACK_HEIGHT * INTERSTITIAL_ZONE_RATIO) {
    return "top";
  }
  if (withinTrackY > TRACK_HEIGHT * (1 - INTERSTITIAL_ZONE_RATIO)) {
    return "bottom";
  }
  return "middle";
}

/**
 * Decide what a drop at `point` resolves to. Single source of truth for both
 * the live preview and the commit:
 *
 * - Directly over a clip → add to that clip (compatibility checked).
 * - Empty area near a track boundary → interstitial: insert a NEW adjustment
 *   track at the gap and place a 5s clip.
 * - Empty middle of an adjustment lane → place a 5s clip on THAT lane, with
 *   collision resolution against its existing clips.
 * - Empty middle of a non-adjustment lane → insert a new adjustment track
 *   above it.
 */
function resolveDropPlacement(
  point: TimelineDropPoint,
  definition: TransformationDefinition,
  model: { clips: TimelineClip[]; tracks: TimelineTrack[] },
  fps: number,
): DropPlacement {
  const { clips, tracks } = model;
  const durationTicks = getFiveSecondsTicks(fps);
  const snappedTick = Math.max(
    0,
    snapTickToFrame(point.tick, getTicksPerFrame(fps)),
  );

  // 1. Directly over a clip → add to the clip's stack.
  if (point.trackId !== null) {
    const clip = findClipAtPoint({
      tracks,
      clips,
      fps,
      trackId: point.trackId,
      tick: point.tick,
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

  // 2. Past the bottom of the stack → append a new adjustment track and draw
  //    the footprint on the row just below the current stack.
  if (point.trackIndex >= tracks.length) {
    return {
      kind: "lane",
      trackIndex: tracks.length,
      trackId: null,
      insertTrackIndex: tracks.length,
      startTick: snappedTick,
      durationTicks,
      compatible: adjustmentCompatible,
    };
  }

  const zone = getZone(point.withinTrackY);

  // 3. Boundary zones → genuine interstitial: insert a new adjustment track at
  //    the boundary. Shown as a gap line only (no footprint rectangle).
  if (zone === "top") {
    return {
      kind: "interstitial",
      gapIndex: point.trackIndex,
      startTick: snappedTick,
      durationTicks,
      compatible: adjustmentCompatible,
    };
  }
  if (zone === "bottom") {
    return {
      kind: "interstitial",
      gapIndex: point.trackIndex + 1,
      startTick: snappedTick,
      durationTicks,
      compatible: adjustmentCompatible,
    };
  }

  // 4. Middle of an existing adjustment lane → place on it, snapping around
  //    any clips already on the lane. Shown as a footprint rectangle.
  const track = tracks[point.trackIndex];
  if (track?.type === "adjustment") {
    const resolvedStart = resolveCollision(
      NEW_ADJUSTMENT_CLIP_ID,
      snappedTick,
      durationTicks,
      track.id,
      clips,
    );
    return {
      kind: "lane",
      trackIndex: point.trackIndex,
      trackId: track.id,
      insertTrackIndex: null,
      startTick: resolvedStart ?? snappedTick,
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
    trackIndex: point.trackIndex,
    trackId: null,
    insertTrackIndex: point.trackIndex,
    startTick: snappedTick,
    durationTicks,
    compatible: adjustmentCompatible,
  };
}

export function useTransformDrag(
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
) {
  const cursorRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      cursorRef.current = { x: event.clientX, y: event.clientY };
    };

    window.addEventListener("pointermove", handlePointerMove, {
      capture: true,
    });
    return () =>
      window.removeEventListener("pointermove", handlePointerMove, {
        capture: true,
      });
  }, []);

  const resolveTimelineDropPoint = useCallback((): TimelineDropPoint | null => {
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

    const relativeX =
      cursor.x - rect.left + container.scrollLeft - TRACK_HEADER_WIDTH;
    if (relativeX < 0) {
      return null;
    }

    const relativeY = cursor.y - rect.top + container.scrollTop - RULER_HEIGHT;
    if (relativeY < 0) {
      return null;
    }

    const { tracks } = getTimelineModelState();
    const trackIndex = Math.floor(relativeY / TRACK_HEIGHT);
    const trackId =
      trackIndex >= 0 && trackIndex < tracks.length
        ? tracks[trackIndex].id
        : null;

    return {
      trackId,
      trackIndex,
      withinTrackY: relativeY - trackIndex * TRACK_HEIGHT,
      tick: Math.max(0, useTimelineViewStore.getState().pxToTicks(relativeX)),
    };
  }, [scrollContainerRef]);

  const computePlacement = useCallback(
    (data: TransformDragData, point: TimelineDropPoint): DropPlacement | null => {
      const definition = resolveDefinition(data);
      if (!definition) {
        return null;
      }
      const { clips, tracks } = getTimelineModelState();
      const fps = useProjectStore.getState().config.fps;
      return resolveDropPlacement(point, definition, { clips, tracks }, fps);
    },
    [],
  );

  const handleTransformDragStart = useCallback((event: DragStartEvent) => {
    if (!isTransformDragData(event.active.data.current)) {
      return;
    }

    useInteractionStore.getState().clearTransformDropPreview();
  }, []);

  const handleTransformDragMove = useCallback(
    (event: DragMoveEvent) => {
      const data = event.active.data.current;
      if (!isTransformDragData(data)) {
        return;
      }

      const point = resolveTimelineDropPoint();
      const interaction = useInteractionStore.getState();
      interaction.setIsOverTimeline(point !== null);

      if (!point) {
        interaction.clearTransformDropPreview();
        return;
      }

      const placement = computePlacement(data, point);
      if (!placement) {
        interaction.clearTransformDropPreview();
        return;
      }

      if (placement.kind === "clip") {
        interaction.setTransformDropPreview({
          kind: "clip",
          clipId: placement.clip.id,
          compatible: placement.compatible,
        });
        return;
      }

      if (placement.kind === "interstitial") {
        interaction.setTransformDropPreview({
          kind: "gap",
          gapIndex: placement.gapIndex,
          compatible: placement.compatible,
        });
        return;
      }

      interaction.setTransformDropPreview({
        kind: "rect",
        trackIndex: placement.trackIndex,
        startTick: placement.startTick,
        durationTicks: placement.durationTicks,
        compatible: placement.compatible,
      });
    },
    [computePlacement, resolveTimelineDropPoint],
  );

  const handleTransformDragEnd = useCallback(
    (event: DragEndEvent) => {
      const data = event.active.data.current;
      const point = resolveTimelineDropPoint();
      const interaction = useInteractionStore.getState();
      interaction.clearTransformDropPreview();
      interaction.setIsOverTimeline(false);

      if (!isTransformDragData(data) || !point) {
        return;
      }

      const placement = computePlacement(data, point);
      if (!placement || !placement.compatible) {
        return;
      }

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
    [computePlacement, resolveTimelineDropPoint],
  );

  const handleTransformDragCancel = useCallback((_event: DragCancelEvent) => {
    const interaction = useInteractionStore.getState();
    interaction.clearTransformDropPreview();
    interaction.setIsOverTimeline(false);
  }, []);

  return {
    handleTransformDragStart,
    handleTransformDragMove,
    handleTransformDragEnd,
    handleTransformDragCancel,
  };
}
