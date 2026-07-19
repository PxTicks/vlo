import { describe, expect, it } from "vitest";
import { TICKS_PER_SECOND } from "../../../../core/time/constants";
import type {
  AdjustmentTimelineClip,
  TimelineClip,
  TimelineTrack,
  VideoTimelineClip,
} from "../../../../types/TimelineTypes";
import { ADJUSTMENT_RETIMING_RIPPLE } from "../../../../types/TimelineTypes";
import {
  createTimelinePlacementMapper,
  timelinePresentationRange,
} from "../timelinePlacementMapper";
import {
  presentationTick,
  storedTrackTick,
} from "../timelineTimeDomains";

const FPS = 30;
const HALF_SECOND = TICKS_PER_SECOND / 2;

function track(id: string, type: TimelineTrack["type"]): TimelineTrack {
  return {
    id,
    type,
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function video(start: number, duration = TICKS_PER_SECOND): VideoTimelineClip {
  return {
    id: "video",
    type: "video",
    name: "Video",
    assetId: "asset",
    trackId: "visual",
    start,
    timelineDuration: duration,
    sourceDuration: duration,
    croppedSourceDuration: duration,
    transformedDuration: duration,
    transformedOffset: 0,
    offset: 0,
    transformations: [],
  };
}

function rippleAdjustment(): AdjustmentTimelineClip {
  return {
    id: "ripple",
    type: "adjustment",
    name: "Ripple",
    trackId: "adjustment",
    start: 0,
    timelineDuration: TICKS_PER_SECOND,
    sourceDuration: 2 * TICKS_PER_SECOND,
    croppedSourceDuration: 2 * TICKS_PER_SECOND,
    transformedDuration: TICKS_PER_SECOND,
    transformedOffset: 0,
    offset: 0,
    transformations: [
      {
        id: "speed",
        type: "speed",
        isEnabled: true,
        parameters: { factor: 2 },
      },
    ],
    depth: 1,
    retimingMode: ADJUSTMENT_RETIMING_RIPPLE,
  };
}

function mapper(clips: TimelineClip[]) {
  return createTimelinePlacementMapper({
    tracks: [track("adjustment", "adjustment"), track("visual", "visual")],
    clips,
    fps: FPS,
  });
}

describe("timelinePlacementMapper", () => {
  it("round-trips presentation and stored ticks without adjustments", () => {
    const source = video(TICKS_PER_SECOND);
    const placement = mapper([source]);

    for (const tick of [
      TICKS_PER_SECOND,
      TICKS_PER_SECOND + HALF_SECOND,
      2 * TICKS_PER_SECOND,
    ]) {
      const stored = placement.mapPresentationTickToStoredTick(
        source.id,
        presentationTick(tick),
      );
      expect(stored).not.toBeNull();
      expect(
        placement.mapStoredTickToPresentationTick(source.id, stored!),
      ).toBeCloseTo(tick, 6);
    }
  });

  it("maps and round-trips a clip shifted by a completed ripple adjustment", () => {
    const adjustment = rippleAdjustment();
    const source = video(2 * TICKS_PER_SECOND);
    const placement = mapper([adjustment, source]);

    expect(placement.getPresentationFootprint(source.id)).toEqual({
      start: TICKS_PER_SECOND,
      end: 2 * TICKS_PER_SECOND,
    });
    expect(
      placement.mapPresentationTickToStoredTick(
        source.id,
        presentationTick(TICKS_PER_SECOND + HALF_SECOND),
      ),
    ).toBe(2 * TICKS_PER_SECOND + HALF_SECOND);
    expect(
      placement.mapStoredTickToPresentationTick(
        source.id,
        storedTrackTick(2 * TICKS_PER_SECOND + HALF_SECOND),
      ),
    ).toBe(TICKS_PER_SECOND + HALF_SECOND);
  });

  it("projects a presentation range into correctly cropped local clips", () => {
    const adjustment = rippleAdjustment();
    const source = video(2 * TICKS_PER_SECOND);
    const placement = mapper([adjustment, source]);
    const range = timelinePresentationRange(
      TICKS_PER_SECOND + HALF_SECOND,
      2 * TICKS_PER_SECOND,
    );

    const segment = placement.intersectClipWithPresentationRange(
      source.id,
      range,
    );
    expect(segment).toEqual(
      expect.objectContaining({
        presentationStart: range.start,
        presentationEnd: range.end,
        storedStart: 2 * TICKS_PER_SECOND + HALF_SECOND,
        storedEnd: 3 * TICKS_PER_SECOND,
        localPresentationStart: 0,
      }),
    );

    const projected = placement.projectRegionToLocalTimeline(range, [source.id]);
    expect(projected.clips).toEqual([
      expect.objectContaining({
        id: source.id,
        start: 0,
        timelineDuration: HALF_SECOND,
        offset: HALF_SECOND,
        transformedOffset: HALF_SECOND,
        croppedSourceDuration: HALF_SECOND,
      }),
    ]);
  });

  it("retains an overlapping ripple adjustment in the projected local stack", () => {
    const adjustment = rippleAdjustment();
    const source = video(TICKS_PER_SECOND);
    const placement = mapper([adjustment, source]);
    const range = timelinePresentationRange(HALF_SECOND, TICKS_PER_SECOND);

    const projected = placement.projectRegionToLocalTimeline(range, [
      adjustment.id,
      source.id,
    ]);
    const localPlacement = mapper(projected.clips);

    expect(projected.clips).toContainEqual(
      expect.objectContaining({
        id: adjustment.id,
        start: 0,
        timelineDuration: HALF_SECOND,
        transformedOffset: HALF_SECOND,
        sourceDuration: TICKS_PER_SECOND,
      }),
    );
    expect(localPlacement.getPresentationFootprint(source.id)).toEqual({
      start: 0,
      end: HALF_SECOND,
    });
  });

  it("pins mappings to the construction snapshot", () => {
    const source = video(TICKS_PER_SECOND);
    const placement = mapper([source]);
    source.start = 5 * TICKS_PER_SECOND;

    expect(placement.getPresentationFootprint(source.id)).toEqual({
      start: TICKS_PER_SECOND,
      end: 2 * TICKS_PER_SECOND,
    });
  });
});
