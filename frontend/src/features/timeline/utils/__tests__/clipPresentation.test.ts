import { describe, expect, it } from "vitest";
import type {
  AdjustmentTimelineClip,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import {
  buildTimelineClipPresentationIndex,
  collectTimelineClipPresentationCollisions,
  introducesTimelineClipPresentationCollision,
} from "../clipPresentation";

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

function speedTransform(factor: number): ClipTransform {
  return {
    id: `speed-${factor}`,
    type: "speed",
    isEnabled: true,
    parameters: { factor },
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
  const sourceDuration = overrides.sourceDuration ?? overrides.timelineDuration;
  return {
    id: overrides.id,
    type: "adjustment",
    name: overrides.id,
    trackId: overrides.trackId,
    start: overrides.start,
    timelineDuration: overrides.timelineDuration,
    sourceDuration,
    transformedDuration: overrides.timelineDuration,
    transformedOffset: 0,
    croppedSourceDuration: sourceDuration,
    offset: 0,
    transformations: overrides.transformations ?? [],
    depth: overrides.depth,
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

describe("clip presentation placement", () => {
  it("expands a descendant clip's presentation span under a slow adjustment", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "adj-1",
        trackId: "adj",
        start: 0,
        timelineDuration: 200,
        sourceDuration: 100,
        depth: 1,
        transformations: [speedTransform(0.5)],
      }),
      videoClip({
        id: "video-1",
        trackId: "v1",
        start: 0,
        timelineDuration: 100,
      }),
    ];

    const presentation = buildTimelineClipPresentationIndex(
      tracks,
      clips,
    ).get("video-1");

    expect(presentation?.start).toBe(0);
    expect(presentation?.end).toBe(200);
    expect(presentation?.duration).toBe(200);
    expect(presentation?.mapPresentationOffsetToClipOffset(150)).toBe(75);
  });

  it("shifts later descendant clips by the accumulated post-window delta", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "adj-1",
        trackId: "adj",
        start: 0,
        timelineDuration: 50,
        sourceDuration: 100,
        depth: 1,
        transformations: [speedTransform(2)],
      }),
      videoClip({
        id: "video-1",
        trackId: "v1",
        start: 120,
        timelineDuration: 20,
      }),
    ];

    const presentation = buildTimelineClipPresentationIndex(
      tracks,
      clips,
    ).get("video-1");

    expect(presentation?.start).toBe(70);
    expect(presentation?.end).toBe(90);
  });

  it("reports presentation overlaps when a proposed timing change introduces one", () => {
    const tracks = [visualTrack("v1")];
    const clips: TimelineClip[] = [
      videoClip({
        id: "left",
        trackId: "v1",
        start: 0,
        timelineDuration: 100,
      }),
      videoClip({
        id: "right",
        trackId: "v1",
        start: 120,
        timelineDuration: 100,
      }),
    ];

    expect(collectTimelineClipPresentationCollisions(tracks, clips)).toEqual([]);
    expect(
      introducesTimelineClipPresentationCollision(tracks, clips, {
        clipId: "left",
        timelineDuration: 130,
      }),
    ).toBe(true);
  });
});
