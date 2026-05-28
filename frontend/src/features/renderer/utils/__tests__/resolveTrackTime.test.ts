import { describe, expect, it } from "vitest";
import type {
  AdjustmentTimelineClip,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { buildTrackTimeResolver } from "../resolveTrackTime";

function adjustmentTrack(id: string): TimelineTrack {
  return {
    id,
    type: "adjustment",
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function visualTrack(id: string): TimelineTrack {
  return {
    id,
    type: "visual",
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function adjustmentClip(overrides: {
  id: string;
  trackId: string;
  start: number;
  timelineDuration: number;
  sourceDuration?: number;
  depth: number;
  transformations?: ClipTransform[];
}): AdjustmentTimelineClip {
  const timelineDuration = overrides.timelineDuration;
  const sourceDuration = overrides.sourceDuration ?? timelineDuration;

  return {
    id: overrides.id,
    type: "adjustment",
    name: overrides.id,
    trackId: overrides.trackId,
    start: overrides.start,
    timelineDuration,
    sourceDuration,
    transformedDuration: timelineDuration,
    transformedOffset: 0,
    croppedSourceDuration: sourceDuration,
    offset: 0,
    transformations: overrides.transformations ?? [],
    depth: overrides.depth,
  };
}

function speedTransform(factor: number): ClipTransform {
  return {
    id: `speed-${factor}`,
    type: "speed",
    isEnabled: true,
    parameters: { factor },
  };
}

describe("buildTrackTimeResolver", () => {
  it("warps ticks inside the window and carries the accumulated delta after it", () => {
    const tracks: TimelineTrack[] = [
      adjustmentTrack("adj"),
      visualTrack("v1"),
    ];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "A",
        trackId: "adj",
        start: 100,
        timelineDuration: 50,
        sourceDuration: 100,
        depth: 1,
        transformations: [speedTransform(2)],
      }),
    ];

    const resolver = buildTrackTimeResolver(tracks, clips);

    expect(resolver.resolveEffectiveTrackTick("v1", 90)).toBe(90);
    expect(resolver.resolveEffectiveTrackTick("v1", 110)).toBe(120);
    expect(resolver.resolveEffectiveTrackTick("v1", 150)).toBe(200);
    expect(resolver.resolveEffectiveTrackTick("v1", 180)).toBe(230);
  });

  it("composes nested adjustments by function composition", () => {
    const tracks: TimelineTrack[] = [
      adjustmentTrack("adjA"),
      adjustmentTrack("adjB"),
      visualTrack("v1"),
    ];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "A",
        trackId: "adjA",
        start: 0,
        timelineDuration: 100,
        sourceDuration: 200,
        depth: 2,
        transformations: [speedTransform(2)],
      }),
      adjustmentClip({
        id: "B",
        trackId: "adjB",
        start: 150,
        timelineDuration: 25,
        sourceDuration: 50,
        depth: 1,
        transformations: [speedTransform(2)],
      }),
    ];

    const resolver = buildTrackTimeResolver(tracks, clips);
    expect(resolver.resolveEffectiveTrackTick("v1", 80)).toBe(170);
  });

  it("returns identity when only non-speed adjustments are present", () => {
    const tracks: TimelineTrack[] = [
      adjustmentTrack("adj"),
      visualTrack("v1"),
    ];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "A",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 1,
        transformations: [
          {
            id: "blur-1",
            type: "filter",
            isEnabled: true,
            parameters: { strength: 8 },
          },
        ],
      }),
    ];

    const resolver = buildTrackTimeResolver(tracks, clips);
    expect(resolver.resolveEffectiveTrackTick("v1", 40)).toBe(40);
  });
});
