import type { DragEndEvent, DragMoveEvent } from "@dnd-kit/core";
import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "../../../../project";
import type { TimelineClip, TimelineTrack } from "../../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../constants";
import { useTimelineStore } from "../../../useTimelineStore";
import { useInteractionStore } from "../../useInteractionStore";
import { useTimelineViewStore } from "../../useTimelineViewStore";
import { getTicksPerFrame, snapTickToFrame } from "../../../../timelineSelection";
import { useClipResize } from "../useClipResize";

const SECOND = TICKS_PER_SECOND;

const track: TimelineTrack = {
  id: "track-1",
  label: "Track 1",
  type: "visual",
  isVisible: true,
  isLocked: false,
  isMuted: false,
};

function clip(id: string, start: number, duration: number): TimelineClip {
  return {
    id,
    trackId: track.id,
    type: "video",
    name: id,
    assetId: `${id}-asset`,
    start,
    timelineDuration: duration,
    sourceDuration: 20 * SECOND,
    croppedSourceDuration: 20 * SECOND,
    transformedDuration: 20 * SECOND,
    transformedOffset: 0,
    offset: 0,
    transformations: [],
  };
}

/** Converts a tick distance into the drag delta the view would report. */
function px(ticks: number): number {
  return useTimelineViewStore.getState().ticksToPx(ticks);
}

function endEvent(deltaTicks: number): DragEndEvent {
  return { delta: { x: px(deltaTicks), y: 0 } } as DragEndEvent;
}

function moveEvent(deltaTicks: number): DragMoveEvent {
  return { delta: { x: px(deltaTicks), y: 0 } } as DragMoveEvent;
}

function shapeOf(id: string) {
  const found = useTimelineStore.getState().clips.find((entry) => entry.id === id)!;
  return { start: found.start, end: found.start + found.timelineDuration };
}

describe("useClipResize snapping and limits", () => {
  let target: TimelineClip;

  beforeEach(() => {
    useProjectStore.setState((state) => ({
      ...state,
      config: { ...state.config, fps: 30 },
    }));
    useTimelineViewStore.setState({ zoomScale: 1 });
    // Shows source 5-15 s of 20 s, leaving 5 s of media on either side.
    target = {
      ...clip("target", 4 * SECOND, 10 * SECOND),
      offset: 5 * SECOND,
      transformedOffset: 5 * SECOND,
    };
    useTimelineStore.setState({
      tracks: [track],
      clips: [target],
      transitions: [],
    });
    useInteractionStore.setState({
      snappingEnabled: true,
      snapPoints: [],
      snapTick: null,
    });
  });

  describe("on release", () => {
    it("snaps a right edge to a nearby point", () => {
      const snapPoint = 15 * SECOND;
      // Land a few pixels short of the snap point.
      const delta = snapPoint - 14 * SECOND - (useTimelineViewStore.getState().pxToTicks(4));

      useClipResize().handleEnd(endEvent(delta), target, "resize_right", {
        enabled: true,
        points: [snapPoint],
      });

      expect(shapeOf("target").end).toBe(snapPoint);
    });

    it("snaps a left edge to a nearby point", () => {
      const snapPoint = 2 * SECOND;
      const delta = -2 * SECOND + useTimelineViewStore.getState().pxToTicks(5);

      useClipResize().handleEnd(endEvent(delta), target, "resize_left", {
        enabled: true,
        points: [snapPoint],
      });

      expect(shapeOf("target")).toEqual({ start: snapPoint, end: 14 * SECOND });
    });

    it("ignores snap points when snapping is off", () => {
      const pxToTicks = useTimelineViewStore.getState().pxToTicks;
      const rawEnd = 15 * SECOND + pxToTicks(3);

      useClipResize().handleEnd(endEvent(rawEnd - 14 * SECOND), target, "resize_right", {
        enabled: false,
        points: [15 * SECOND + pxToTicks(5)],
      });

      // Without a snap the raw end is only rounded to the frame grid.
      expect(shapeOf("target").end).toBe(
        snapTickToFrame(rawEnd, getTicksPerFrame(30)),
      );
    });

    it("does not snap past the end of the source media", () => {
      // 5 s of media remain after the shown range, so the end can reach 19 s.
      const beyondSource = 19 * SECOND + useTimelineViewStore.getState().pxToTicks(2);

      useClipResize().handleEnd(
        endEvent(beyondSource - 14 * SECOND),
        target,
        "resize_right",
        { enabled: true, points: [beyondSource] },
      );

      expect(shapeOf("target").end).toBe(19 * SECOND);
    });

    it("stops a left edge at the neighbouring clip", () => {
      const neighbour = clip("neighbour", 0, 3 * SECOND);
      useTimelineStore.setState({ clips: [neighbour, target] });

      useClipResize().handleEnd(endEvent(-4 * SECOND), target, "resize_left");

      expect(shapeOf("target").start).toBe(3 * SECOND);
      expect(shapeOf("neighbour")).toEqual({ start: 0, end: 3 * SECOND });
    });

    it("stops a right edge at the neighbouring clip", () => {
      const neighbour = clip("neighbour", 16 * SECOND, 2 * SECOND);
      useTimelineStore.setState({ clips: [target, neighbour] });

      useClipResize().handleEnd(endEvent(4 * SECOND), target, "resize_right");

      expect(shapeOf("target").end).toBe(16 * SECOND);
    });
  });

  describe("while dragging", () => {
    it("clears the preview when snapping is off or there is nothing to snap to", () => {
      useInteractionStore.setState({ snapTick: 123, snapPoints: [] });
      useClipResize().handleMove(moveEvent(SECOND), target, "resize_right");
      expect(useInteractionStore.getState().snapTick).toBeNull();

      useInteractionStore.setState({
        snapTick: 123,
        snapPoints: [15 * SECOND],
        snappingEnabled: false,
      });
      useClipResize().handleMove(moveEvent(SECOND), target, "resize_right");
      expect(useInteractionStore.getState().snapTick).toBeNull();
    });

    it.each([
      ["right", "resize_right" as const, 14 * SECOND, 15 * SECOND],
      ["left", "resize_left" as const, 4 * SECOND, 3 * SECOND],
    ])("previews a snap for the %s edge near a point", (_side, operation, edge, point) => {
      useInteractionStore.setState({ snapPoints: [point] });
      const nearly = point - edge - useTimelineViewStore.getState().pxToTicks(4);

      useClipResize().handleMove(moveEvent(nearly), target, operation);

      expect(useInteractionStore.getState().snapTick).toBe(point);
    });

    it.each([
      ["right", "resize_right" as const, 14 * SECOND, 15 * SECOND],
      ["left", "resize_left" as const, 4 * SECOND, 3 * SECOND],
    ])("holds a %s snap within the hysteresis band, then releases it", (_side, operation, edge, point) => {
      const pxToTicks = useTimelineViewStore.getState().pxToTicks;
      // Only a far-away point is offered now, so no new candidate exists.
      useInteractionStore.setState({ snapPoints: [100 * SECOND], snapTick: point });

      // 12 px past the held snap: outside the 10 px threshold, inside 13 px.
      useClipResize().handleMove(
        moveEvent(point - edge + pxToTicks(12)),
        target,
        operation,
      );
      expect(useInteractionStore.getState().snapTick).toBe(point);

      useClipResize().handleMove(
        moveEvent(point - edge + pxToTicks(40)),
        target,
        operation,
      );
      expect(useInteractionStore.getState().snapTick).toBeNull();
    });

    it("refuses to preview a snap the clip cannot reach", () => {
      const neighbour = clip("neighbour", 0, 3 * SECOND);
      useTimelineStore.setState({ clips: [neighbour, target] });
      // 2 s is inside the neighbour, beyond the left edge's limit.
      useInteractionStore.setState({ snapPoints: [2 * SECOND] });

      useClipResize().handleMove(
        moveEvent(-2 * SECOND),
        target,
        "resize_left",
      );

      expect(useInteractionStore.getState().snapTick).toBeNull();
    });
  });
});
