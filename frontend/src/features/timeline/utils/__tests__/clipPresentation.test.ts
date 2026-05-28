import { describe, expect, it } from "vitest";
import type {
  AdjustmentTimelineClip,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import {
  buildTimelineClipPresentationCollisionView,
  buildTimelineClipPresentationIndex,
  buildTimelineClipPresentationLookup,
  collectTimelineClipPresentationCollisions,
  introducesTimelineClipPresentationCollision,
  resolveStoredEndForPresentationEnd,
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

describe("clip presentation placement (per-clip model)", () => {
  it("compresses an intersecting clip's footprint under a fast (2x) adjustment", () => {
    // adj on its own track: timelineDuration=50, sourceDuration=100 → speed = 2x.
    // Adjustment's stored range on adj track is [0, 50). Clip stored fully
    // intersects the adjustment's reach below it.
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
      }),
    ];

    const presentation = buildTimelineClipPresentationIndex(
      tracks,
      clips,
    ).get("video-1");

    // Stored start is preserved (no shift). The footprint compresses by 1/2:
    // 100 stored ticks → 50 presentation ticks.
    expect(presentation?.start).toBe(0);
    expect(presentation?.end).toBe(50);
    expect(presentation?.duration).toBe(50);
    // At the halfway point of the compressed footprint, we should be at
    // halfway through the clip's 100-tick source range.
    expect(presentation?.mapPresentationOffsetToClipOffset(25)).toBe(50);
  });

  it("expands an intersecting clip under a slow (0.5x) adjustment", () => {
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

  it("leaves a later non-intersecting clip in place (no global shift)", () => {
    // This is the key per-clip-model property: a clip that does NOT
    // intersect the adjustment's stored reach stays at its stored start.
    // In the old global-warp model this clip would have been shifted left
    // by the accumulated post-window delta.
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

    expect(presentation?.start).toBe(120);
    expect(presentation?.end).toBe(140);
    expect(presentation?.duration).toBe(20);
  });

  it("does not retime a clip that starts at a fast adjustment's visible end", () => {
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
        start: 50,
        timelineDuration: 100,
      }),
    ];

    const presentation = buildTimelineClipPresentationIndex(
      tracks,
      clips,
    ).get("video-1");

    expect(presentation?.start).toBe(50);
    expect(presentation?.end).toBe(150);
    expect(presentation?.duration).toBe(100);
    expect(presentation?.mapPresentationOffsetToClipOffset(25)).toBe(25);
  });

  it("retimes only the visible overlap with an adjustment footprint", () => {
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
        start: 25,
        timelineDuration: 100,
      }),
    ];

    const presentation = buildTimelineClipPresentationIndex(
      tracks,
      clips,
    ).get("video-1");

    expect(presentation?.start).toBe(25);
    expect(presentation?.end).toBe(100);
    expect(presentation?.duration).toBe(75);
    expect(presentation?.mapPresentationOffsetToClipOffset(25)).toBe(50);
    expect(presentation?.mapPresentationOffsetToClipOffset(75)).toBe(100);
  });

  it("identity-maps clips when only non-speed adjustments are present", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "adj-1",
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
      videoClip({
        id: "video-1",
        trackId: "v1",
        start: 10,
        timelineDuration: 80,
      }),
    ];

    const presentation = buildTimelineClipPresentationIndex(
      tracks,
      clips,
    ).get("video-1");

    expect(presentation?.start).toBe(10);
    expect(presentation?.end).toBe(90);
    expect(presentation?.duration).toBe(80);
  });
});

describe("findActiveClipAt lookup", () => {
  it("returns the active clip and rebased effective tick at a presentation tick inside its footprint", () => {
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
      }),
    ];

    const lookup = buildTimelineClipPresentationLookup(tracks, clips);

    // Presentation tick 25 is halfway through video-1's compressed footprint.
    const resolved = lookup.findActiveClipAt("v1", 25);
    expect(resolved?.clip.id).toBe("video-1");
    // Halfway through a 50-presentation-tick footprint maps to source
    // tick 50 (halfway through 100 stored ticks).
    expect(resolved?.effectiveTick).toBe(50);
    expect(resolved?.presentationInputTick).toBe(25);
  });

  it("returns null outside any clip's presentation footprint", () => {
    const tracks = [visualTrack("v1")];
    const clips: TimelineClip[] = [
      videoClip({
        id: "video-1",
        trackId: "v1",
        start: 100,
        timelineDuration: 50,
      }),
    ];

    const lookup = buildTimelineClipPresentationLookup(tracks, clips);
    expect(lookup.findActiveClipAt("v1", 50)).toBeNull();
    expect(lookup.findActiveClipAt("v1", 200)).toBeNull();
  });
});

describe("resolveStoredEndForPresentationEnd", () => {
  it("is identity outside any adjustment", () => {
    const tracks = [visualTrack("v1")];
    const clip = videoClip({
      id: "video-1",
      trackId: "v1",
      start: 50,
      timelineDuration: 100,
    });

    expect(resolveStoredEndForPresentationEnd(tracks, [clip], clip, 200)).toBe(
      200,
    );
  });

  it("rebases through the engine when the new end falls inside an adjustment", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clip = videoClip({
      id: "video-1",
      trackId: "v1",
      start: 0,
      timelineDuration: 100,
    });
    const adj = adjustmentClip({
      id: "adj-1",
      trackId: "adj",
      start: 0,
      timelineDuration: 50,
      sourceDuration: 100,
      depth: 1,
      transformations: [speedTransform(2)],
    });

    // Clip currently presents at [0, 50). Dragging the right edge to
    // presentation tick 25 should make the stored end land at stored 50
    // (the speed factor doubles the stored-tick delta).
    expect(
      resolveStoredEndForPresentationEnd(tracks, [adj, clip], clip, 25),
    ).toBe(50);
  });

  it("keeps right resize identity after a fast adjustment's visible end", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clip = videoClip({
      id: "video-1",
      trackId: "v1",
      start: 50,
      timelineDuration: 100,
    });
    const adj = adjustmentClip({
      id: "adj-1",
      trackId: "adj",
      start: 0,
      timelineDuration: 50,
      sourceDuration: 100,
      depth: 1,
      transformations: [speedTransform(2)],
    });

    expect(
      resolveStoredEndForPresentationEnd(tracks, [adj, clip], clip, 75),
    ).toBe(75);
  });
});

describe("presentation collisions", () => {
  it("builds a collision view using presentation durations", () => {
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

    const collisionClip = buildTimelineClipPresentationCollisionView(
      tracks,
      clips,
    ).find((clip) => clip.id === "video-1");

    expect(collisionClip?.start).toBe(0);
    expect(collisionClip?.timelineDuration).toBe(200);
  });

  it("reports descendant collisions introduced by an adjustment speed change", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "adj-1",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        sourceDuration: 100,
        depth: 1,
        transformations: [],
      }),
      videoClip({
        id: "left",
        trackId: "v1",
        start: 0,
        timelineDuration: 100,
      }),
      videoClip({
        id: "right",
        trackId: "v1",
        start: 150,
        timelineDuration: 50,
      }),
    ];

    expect(
      introducesTimelineClipPresentationCollision(tracks, clips, {
        clipId: "adj-1",
        transformations: [speedTransform(0.5)],
        timelineDuration: 200,
        transformedDuration: 200,
      }),
    ).toBe(true);
  });

  it("reports collisions when a proposed timing change introduces one", () => {
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
