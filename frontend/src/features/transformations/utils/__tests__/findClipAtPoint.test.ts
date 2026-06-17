import { describe, expect, it } from "vitest";
import type {
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { findClipAtPoint } from "../findClipAtPoint";

const FPS = 30;

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

function videoClip(overrides: {
  id: string;
  trackId: string;
  start: number;
  timelineDuration: number;
}): TimelineClip {
  return {
    id: overrides.id,
    type: "video",
    name: overrides.id,
    trackId: overrides.trackId,
    assetId: `asset-${overrides.id}`,
    start: overrides.start,
    timelineDuration: overrides.timelineDuration,
    sourceDuration: overrides.timelineDuration,
    transformedDuration: overrides.timelineDuration,
    transformedOffset: 0,
    croppedSourceDuration: overrides.timelineDuration,
    offset: 0,
    transformations: [],
  };
}

describe("findClipAtPoint", () => {
  const tracks = [visualTrack("track-1"), visualTrack("track-2")];
  const clips = [
    videoClip({
      id: "clip-1",
      trackId: "track-1",
      start: 3200,
      timelineDuration: 9600,
    }),
  ];

  it("returns the clip whose presentation span contains the tick", () => {
    expect(
      findClipAtPoint({
        tracks,
        clips,
        fps: FPS,
        trackId: "track-1",
        tick: 6400,
      })?.id,
    ).toBe("clip-1");
  });

  it("returns null for an empty gap", () => {
    expect(
      findClipAtPoint({
        tracks,
        clips,
        fps: FPS,
        trackId: "track-1",
        tick: 16000,
      }),
    ).toBeNull();
  });

  it("returns null when the tick is over another track", () => {
    expect(
      findClipAtPoint({
        tracks,
        clips,
        fps: FPS,
        trackId: "track-2",
        tick: 6400,
      }),
    ).toBeNull();
  });
});
