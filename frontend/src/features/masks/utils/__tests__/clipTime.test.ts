import { describe, expect, it } from "vitest";
import type {
  AdjustmentTimelineClip,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline";
import { toClipInputTimeTicks } from "../clipTime";

const GRID_FPS = TICKS_PER_SECOND;

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

function speedTransform(factor: number): ClipTransform {
  return {
    id: `speed-${factor}`,
    type: "speed",
    isEnabled: true,
    parameters: { factor },
  };
}

function videoClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: "video-1",
    type: "video",
    name: "Video",
    trackId: "v1",
    assetId: "asset-1",
    start: 0,
    timelineDuration: 100,
    sourceDuration: 100,
    transformedDuration: 100,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    offset: 0,
    transformations: [],
    ...overrides,
  } as TimelineClip;
}

function adjustmentClip(): AdjustmentTimelineClip {
  return {
    id: "adj-1",
    type: "adjustment",
    name: "Adjustment",
    trackId: "adj",
    start: 0,
    timelineDuration: 50,
    sourceDuration: 100,
    transformedDuration: 50,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    offset: 0,
    transformations: [speedTransform(2)],
    depth: 1,
  };
}

describe("toClipInputTimeTicks", () => {
  it("maps global time through clip speed without presentation context", () => {
    const clip = videoClip({ transformations: [speedTransform(2)] });

    expect(toClipInputTimeTicks(clip, 25)).toBe(50);
  });

  it("maps presentation time through adjustment retiming to sourceTimeTicks", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clip = videoClip();
    const clips = [adjustmentClip(), clip];

    expect(
      toClipInputTimeTicks(clip, 25, {
        tracks,
        clips,
        fps: GRID_FPS,
      }),
    ).toBe(50);
  });

  it("still composes adjustment retiming with the clip's own speed stack", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clip = videoClip({ transformations: [speedTransform(2)] });
    const clips = [adjustmentClip(), clip];

    expect(
      toClipInputTimeTicks(clip, 25, {
        tracks,
        clips,
        fps: GRID_FPS,
      }),
    ).toBe(100);
  });
});
