import { beforeEach, describe, expect, it } from "vitest";
import type {
  AdjustmentTimelineClip,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { buildTimelineSnapPoints } from "../useInteractionStore";
import { useTimelineStore } from "../../useTimelineStore";

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
  sourceDuration: number;
  depth: number;
  transformations: ClipTransform[];
}): AdjustmentTimelineClip {
  return {
    id: overrides.id,
    type: "adjustment",
    name: overrides.id,
    trackId: overrides.trackId,
    start: overrides.start,
    timelineDuration: overrides.timelineDuration,
    sourceDuration: overrides.sourceDuration,
    transformedDuration: overrides.timelineDuration,
    transformedOffset: 0,
    croppedSourceDuration: overrides.sourceDuration,
    offset: 0,
    transformations: overrides.transformations,
    depth: overrides.depth,
  };
}

function videoClip(overrides: {
  id: string;
  trackId: string;
  start: number;
  timelineDuration: number;
  markerSourceTimeTicks: number;
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
    components: [
      {
        id: "markers-1",
        type: "markers",
        isEnabled: true,
        parameters: {
          markers: [
            {
              id: "marker-1",
              sourceTimeTicks: overrides.markerSourceTimeTicks,
            },
          ],
        },
      },
    ],
  };
}

describe("buildTimelineSnapPoints", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      tracks: [],
      clips: [],
      selectedClipIds: [],
    });
  });

  it("projects marker snap points through the clip presentation map", () => {
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
        start: 0,
        timelineDuration: 100,
        markerSourceTimeTicks: 50,
      }),
    ];

    useTimelineStore.setState({ tracks, clips });

    expect(buildTimelineSnapPoints()).toEqual([0, 25, 50]);
  });
});
