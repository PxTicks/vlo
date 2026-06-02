import { describe, expect, it } from "vitest";
import type {
  AdjustmentRetimingMode,
  AdjustmentTimelineClip,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { ADJUSTMENT_RETIMING_RIPPLE } from "../../../../types/TimelineTypes";
import {
  buildTimelineClipPresentationCollisionView,
  buildTimelineClipPresentationIndex,
  buildTimelineClipPresentationLookup,
  collectTimelineClipPresentationCollisions,
  computeFurthestPresentationEnd,
  introducesTimelineClipPresentationCollision,
  resolveStoredEndForPresentationEnd,
  resolveStoredStartForPresentationStart,
} from "../clipPresentation";
import { TICKS_PER_SECOND } from "../../constants";

// These unit tests operate on abstract integer-tick geometry. Driving the
// frame grid at one tick per frame (fps = TICKS_PER_SECOND) makes quantization
// an identity on integers, so the assertions exercise presentation/collision
// logic rather than frame snapping (which is covered in frameGrid.test.ts).
const GRID_FPS = TICKS_PER_SECOND;

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
  retimingMode?: AdjustmentRetimingMode;
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
    retimingMode: overrides.retimingMode,
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
      GRID_FPS,
    ).get("video-1");

    // Stored start is preserved (no shift). The footprint compresses by 1/2:
    // 100 stored ticks → 50 presentation ticks.
    expect(presentation?.start).toBe(0);
    expect(presentation?.end).toBe(50);
    expect(presentation?.duration).toBe(50);
    // At the halfway point of the compressed footprint, we should be at
    // halfway through the clip's 100-tick source range.
    expect(presentation?.mapPresentationOffsetToClipOffset(25)).toBe(50);
    expect(presentation?.mapClipOffsetToPresentationOffset(50)).toBe(25);
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
      GRID_FPS,
    ).get("video-1");

    expect(presentation?.start).toBe(0);
    expect(presentation?.end).toBe(200);
    expect(presentation?.duration).toBe(200);
    expect(presentation?.mapPresentationOffsetToClipOffset(150)).toBe(75);
    expect(presentation?.mapClipOffsetToPresentationOffset(75)).toBe(150);
  });

  it("leaves a later non-intersecting clip in place (no global shift)", () => {
    // Static retiming pins clips that do NOT intersect the adjustment's
    // stored reach. Ripple retiming covers the old global-warp behavior.
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
      GRID_FPS,
    ).get("video-1");

    expect(presentation?.start).toBe(120);
    expect(presentation?.end).toBe(140);
    expect(presentation?.duration).toBe(20);
  });

  it("ripples later clips when the adjustment uses ripple retiming", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "adj-1",
        trackId: "adj",
        start: 0,
        timelineDuration: 50,
        sourceDuration: 100,
        depth: 1,
        retimingMode: ADJUSTMENT_RETIMING_RIPPLE,
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
      GRID_FPS,
    ).get("video-1");

    expect(presentation?.start).toBe(70);
    expect(presentation?.end).toBe(90);
    expect(presentation?.duration).toBe(20);
  });

  it("inverts ripple placement so drops commit to the visual target", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "adj-1",
        trackId: "adj",
        start: 0,
        timelineDuration: 50,
        sourceDuration: 100,
        depth: 1,
        retimingMode: ADJUSTMENT_RETIMING_RIPPLE,
        transformations: [speedTransform(2)],
      }),
      videoClip({
        id: "video-1",
        trackId: "v1",
        start: 0,
        timelineDuration: 20,
      }),
    ];

    const storedStart = resolveStoredStartForPresentationStart(
      tracks,
      clips,
      "v1",
      70,
    );
    const movedClips = clips.map((clip) =>
      clip.id === "video-1" ? { ...clip, start: storedStart } : clip,
    );
    const presentation = buildTimelineClipPresentationIndex(
      tracks,
      movedClips,
      GRID_FPS,
    ).get("video-1");

    expect(storedStart).toBe(120);
    expect(presentation?.start).toBe(70);
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
      GRID_FPS,
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
      GRID_FPS,
    ).get("video-1");

    expect(presentation?.start).toBe(25);
    expect(presentation?.end).toBe(100);
    expect(presentation?.duration).toBe(75);
    expect(presentation?.mapPresentationOffsetToClipOffset(25)).toBe(50);
    expect(presentation?.mapPresentationOffsetToClipOffset(75)).toBe(100);
    expect(presentation?.mapClipOffsetToPresentationOffset(50)).toBe(25);
    expect(presentation?.mapClipOffsetToPresentationOffset(100)).toBe(75);
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
      GRID_FPS,
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

    const lookup = buildTimelineClipPresentationLookup(tracks, clips, GRID_FPS);

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

    const lookup = buildTimelineClipPresentationLookup(tracks, clips, GRID_FPS);
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
      GRID_FPS,
    ).find((clip) => clip.id === "video-1");

    expect(collisionClip?.start).toBe(0);
    expect(collisionClip?.timelineDuration).toBe(200);
  });

  it("applies adjustment source-window growth when previewing descendant layout", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "adj-1",
        trackId: "adj",
        start: 0,
        timelineDuration: 50,
        sourceDuration: 100,
        depth: 1,
        retimingMode: ADJUSTMENT_RETIMING_RIPPLE,
        transformations: [speedTransform(2)],
      }),
      videoClip({
        id: "video-1",
        trackId: "v1",
        start: 120,
        timelineDuration: 20,
      }),
    ];

    const collisionClip = buildTimelineClipPresentationCollisionView(
      tracks,
      clips,
      GRID_FPS,
      {
        clipId: "adj-1",
        timelineDuration: 60,
        croppedSourceDuration: 120,
      },
    ).find((clip) => clip.id === "video-1");

    expect(collisionClip?.start).toBe(60);
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
      introducesTimelineClipPresentationCollision(tracks, clips, GRID_FPS, {
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

    expect(
      collectTimelineClipPresentationCollisions(tracks, clips, GRID_FPS),
    ).toEqual([]);
    expect(
      introducesTimelineClipPresentationCollision(tracks, clips, GRID_FPS, {
        clipId: "left",
        timelineDuration: 130,
      }),
    ).toBe(true);
  });
});

describe("computeFurthestPresentationEnd", () => {
  it("extends past the stored end when a slow ramp pushes a clip's tail forward", () => {
    // 0.5x adjustment: source window [0, 100) → presentation [0, 200). The clip
    // runs 150 stored ticks, so its tail [100, 150) carries forward to
    // presentation [200, 250). Raw stored ends would top out at the
    // adjustment's 200.
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "adj-slow",
        trackId: "adj",
        start: 0,
        timelineDuration: 200,
        sourceDuration: 100,
        depth: 1,
        transformations: [speedTransform(0.5)],
      }),
      videoClip({ id: "v", trackId: "v1", start: 0, timelineDuration: 150 }),
    ];

    expect(computeFurthestPresentationEnd(tracks, clips, GRID_FPS)).toBe(250);
  });

  it("measures only the subset while resolving presentation against the full timeline", () => {
    // adj reaches only v1 (depth 1). videoA on v1 expands under the ramp;
    // videoB on the unreached v2 is the furthest stored clip.
    const tracks = [
      adjustmentTrack("adj"),
      visualTrack("v1"),
      visualTrack("v2"),
    ];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "adj-slow",
        trackId: "adj",
        start: 0,
        timelineDuration: 200,
        sourceDuration: 100,
        depth: 1,
        transformations: [speedTransform(0.5)],
      }),
      videoClip({ id: "a", trackId: "v1", start: 0, timelineDuration: 150 }),
      videoClip({ id: "b", trackId: "v2", start: 0, timelineDuration: 400 }),
    ];

    // Whole timeline: videoB is furthest at 400.
    expect(computeFurthestPresentationEnd(tracks, clips, GRID_FPS)).toBe(400);
    // Subset = videoA only: its presentation still resolves through the
    // adjustment (250), proving the full timeline drives presentation while the
    // subset narrows what we measure.
    const videoA = clips.filter((clip) => clip.id === "a");
    expect(
      computeFurthestPresentationEnd(tracks, clips, GRID_FPS, videoA),
    ).toBe(250);
  });
});
