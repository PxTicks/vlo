import { describe, expect, it } from "vitest";
import type {
  AdjustmentTimelineClip,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import {
  computeAdjustmentApplications,
  computeAdjustmentTimeApplications,
  deriveActiveAdjustmentGroups,
} from "../deriveAdjustmentGroups";

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

function audioTrack(id: string): TimelineTrack {
  return {
    id,
    type: "audio",
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
  depth: number;
  sourceDuration?: number;
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

function videoClip(id: string, trackId: string): TimelineClip {
  return {
    id,
    type: "video",
    name: id,
    trackId,
    assetId: `asset-${id}`,
    start: 0,
    timelineDuration: 1000,
    sourceDuration: 1000,
    transformedDuration: 1000,
    transformedOffset: 0,
    croppedSourceDuration: 1000,
    offset: 0,
    transformations: [],
  } as TimelineClip;
}

describe("computeAdjustmentApplications", () => {
  it("returns empty when no adjustment clips are active at the tick", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1"), visualTrack("v2")];
    const clips = [
      adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 2,
      }),
    ];
    const apps = computeAdjustmentApplications(tracks, clips, 200); // outside
    expect(apps.size).toBe(0);
  });

  it("includes only visual tracks among the next N tracks below", () => {
    // Stack: adj (pos 0), audio (pos 1), visual v1 (pos 2), visual v2 (pos 3).
    // depth=3 → next 3 tracks below pos 0 = positions 1, 2, 3.
    // Of those, the audio at pos 1 is non-visual and gets no application.
    const tracks = [
      adjustmentTrack("adj"),
      audioTrack("a1"),
      visualTrack("v1"),
      visualTrack("v2"),
    ];
    const clips = [
      adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 3,
      }),
    ];
    const apps = computeAdjustmentApplications(tracks, clips, 50);
    expect(apps.get("a1")).toBeUndefined();
    expect(apps.get("v1")).toHaveLength(1);
    expect(apps.get("v2")).toHaveLength(1);
  });

  it("clamps depth at the bottom of the track stack", () => {
    const tracks = [
      adjustmentTrack("adj"),
      visualTrack("v1"),
      visualTrack("v2"),
    ];
    const clips = [
      adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 100, // way beyond
      }),
    ];
    const apps = computeAdjustmentApplications(tracks, clips, 50);
    expect(apps.get("v1")).toHaveLength(1);
    expect(apps.get("v2")).toHaveLength(1);
  });

  it("uses half-open [start, start + duration) semantics", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips = [
      adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 100,
        timelineDuration: 50,
        depth: 1,
      }),
    ];
    // At start (inclusive)
    expect(computeAdjustmentApplications(tracks, clips, 100).get("v1")).toHaveLength(1);
    // One tick before end (inclusive)
    expect(computeAdjustmentApplications(tracks, clips, 149).get("v1")).toHaveLength(1);
    // At end (exclusive)
    expect(computeAdjustmentApplications(tracks, clips, 150).get("v1")).toBeUndefined();
    // Before start
    expect(computeAdjustmentApplications(tracks, clips, 99).get("v1")).toBeUndefined();
  });

  it("sorts the per-track stack innermost-first (highest adjustment position) → outermost-last (lowest position)", () => {
    // adjA at pos 0 (outermost), adjB at pos 1 (innermost), then v1 at pos 2.
    // Both reach v1.
    const tracks = [
      adjustmentTrack("adjA"),
      adjustmentTrack("adjB"),
      visualTrack("v1"),
    ];
    const clips = [
      adjustmentClip({
        id: "A",
        trackId: "adjA",
        start: 0,
        timelineDuration: 100,
        depth: 2,
      }),
      adjustmentClip({
        id: "B",
        trackId: "adjB",
        start: 0,
        timelineDuration: 100,
        depth: 1,
      }),
    ];
    const apps = computeAdjustmentApplications(tracks, clips, 50);
    const v1Stack = apps.get("v1") ?? [];
    expect(v1Stack.map((a) => a.sourceClipId)).toEqual(["B", "A"]);
  });

  it("skips adjustment clips on hidden adjustment tracks", () => {
    const tracks = [
      { ...adjustmentTrack("adj"), isVisible: false },
      visualTrack("v1"),
    ];
    const clips = [
      adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 1,
      }),
    ];
    const apps = computeAdjustmentApplications(tracks, clips, 50);
    expect(apps.size).toBe(0);
  });

  it("ignores hidden visual tracks", () => {
    const tracks = [
      adjustmentTrack("adj"),
      { ...visualTrack("v1"), isVisible: false },
      visualTrack("v2"),
    ];
    const clips = [
      adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 2,
      }),
    ];
    const apps = computeAdjustmentApplications(tracks, clips, 50);
    expect(apps.get("v1")).toBeUndefined();
    expect(apps.get("v2")).toHaveLength(1);
  });

  it("ignores non-adjustment clips", () => {
    const tracks = [visualTrack("v1")];
    const clips = [videoClip("clip1", "v1")];
    const apps = computeAdjustmentApplications(tracks, clips, 50);
    expect(apps.size).toBe(0);
  });

  it("activates inner adjustments in the outer-warped input domain", () => {
    const tracks = [
      adjustmentTrack("adjA"),
      adjustmentTrack("adjB"),
      visualTrack("v1"),
    ];
    const clips = [
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
        depth: 1,
      }),
    ];

    const apps = computeAdjustmentApplications(tracks, clips, 80);
    expect((apps.get("v1") ?? []).map((application) => application.sourceClipId)).toEqual([
      "B",
      "A",
    ]);
  });
});

describe("computeAdjustmentTimeApplications", () => {
  it("includes audio tracks in reach but excludes adjustment tracks", () => {
    const tracks = [
      adjustmentTrack("adjOuter"),
      audioTrack("a1"),
      adjustmentTrack("adjInner"),
      visualTrack("v1"),
    ];
    const clips = [
      adjustmentClip({
        id: "outer",
        trackId: "adjOuter",
        start: 0,
        timelineDuration: 100,
        sourceDuration: 200,
        depth: 3,
        transformations: [speedTransform(2)],
      }),
    ];

    const apps = computeAdjustmentTimeApplications(tracks, clips);
    expect(apps.get("a1")).toHaveLength(1);
    expect(apps.get("v1")).toHaveLength(1);
    expect(apps.get("adjInner")).toBeUndefined();
  });

  it("skips adjustments with no enabled speed transforms", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips = [
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
            parameters: { strength: 4 },
          },
        ],
      }),
    ];

    expect(computeAdjustmentTimeApplications(tracks, clips).size).toBe(0);
  });
});

describe("deriveActiveAdjustmentGroups", () => {
  it("returns an empty forest when no adjustments are active", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips = [
      adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 1,
      }),
    ];
    expect(deriveActiveAdjustmentGroups(tracks, clips, 200)).toEqual([]);
  });

  it("produces a single top-level group that wraps a contiguous run of tracks", () => {
    const tracks = [
      adjustmentTrack("adj"),
      visualTrack("v1"),
      visualTrack("v2"),
    ];
    const clips = [
      adjustmentClip({
        id: "A",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 2,
      }),
    ];
    const forest = deriveActiveAdjustmentGroups(tracks, clips, 50);
    expect(forest).toHaveLength(1);
    expect(forest[0].sourceClipId).toBe("A");
    expect(forest[0].trackIds).toEqual(["v1", "v2"]);
    expect(forest[0].children).toEqual([]);
  });

  it("produces two disjoint top-level groups when reach sets don't share tracks", () => {
    const tracks = [
      adjustmentTrack("adjA"),
      visualTrack("v1"),
      adjustmentTrack("adjB"),
      visualTrack("v2"),
    ];
    const clips = [
      adjustmentClip({
        id: "A",
        trackId: "adjA",
        start: 0,
        timelineDuration: 100,
        depth: 1,
      }),
      adjustmentClip({
        id: "B",
        trackId: "adjB",
        start: 0,
        timelineDuration: 100,
        depth: 1,
      }),
    ];
    const forest = deriveActiveAdjustmentGroups(tracks, clips, 50);
    expect(forest).toHaveLength(2);
    expect(forest[0].sourceClipId).toBe("A");
    expect(forest[0].trackIds).toEqual(["v1"]);
    expect(forest[1].sourceClipId).toBe("B");
    expect(forest[1].trackIds).toEqual(["v2"]);
  });

  it("fully nests an inner group inside an outer one whose reach is a superset", () => {
    // Outer A reaches v1, v2, v3. Inner B reaches v1, v2 — a contiguous
    // subset of A's reach, so B nests fully inside A.
    const tracks = [
      adjustmentTrack("adjA"),
      adjustmentTrack("adjB"),
      visualTrack("v1"),
      visualTrack("v2"),
      visualTrack("v3"),
    ];
    const clips = [
      adjustmentClip({
        id: "A",
        trackId: "adjA",
        start: 0,
        timelineDuration: 100,
        depth: 4, // covers adjB at pos 1, v1 at pos 2, v2 at pos 3, v3 at pos 4
      }),
      adjustmentClip({
        id: "B",
        trackId: "adjB",
        start: 0,
        timelineDuration: 100,
        depth: 2, // covers v1 at pos 2, v2 at pos 3
      }),
    ];
    const forest = deriveActiveAdjustmentGroups(tracks, clips, 50);
    // A wraps v1 + v2 + v3; B wraps v1 + v2 nested inside A.
    expect(forest).toHaveLength(1);
    expect(forest[0].sourceClipId).toBe("A");
    expect(forest[0].trackIds).toEqual(["v1", "v2", "v3"]);
    expect(forest[0].children).toHaveLength(1);
    expect(forest[0].children[0].sourceClipId).toBe("B");
    expect(forest[0].children[0].trackIds).toEqual(["v1", "v2"]);
  });

  it("handles partial overlap by splitting a clip's reach across multiple containers", () => {
    // The load-bearing case from the plan.
    //
    // Track layout (top to bottom):
    //   pos 0 = adjA, pos 1 = adjB,
    //   pos 2 = v1, pos 3 = v2, pos 4 = v3
    //
    // A at pos 0, depth 3 → reach pos 1, 2, 3 → visual v1, v2 (pos 1 is
    //   adjB and contributes nothing; clamps after pos 3).
    // B at pos 1, depth 3 → reach pos 2, 3, 4 → visual v1, v2, v3.
    //
    // So A and B partially overlap: both cover v1 and v2; only B covers v3.
    //
    // Per-track stacks (innermost → outermost):
    //   v1: [B, A]
    //   v2: [B, A]
    //   v3: [B]
    //
    // Expected forest at the outermost layer:
    //   A wraps v1, v2 (depth=0 has A for v1+v2; v3 has no A so the run breaks)
    //     inside A: B wraps v1, v2 (depth=1 has B for v1+v2)
    //   B wraps v3 (depth=0 has B for v3 — the run resumes for B alone)
    const tracks = [
      adjustmentTrack("adjA"),
      adjustmentTrack("adjB"),
      visualTrack("v1"),
      visualTrack("v2"),
      visualTrack("v3"),
    ];
    const clips = [
      adjustmentClip({
        id: "A",
        trackId: "adjA",
        start: 0,
        timelineDuration: 100,
        depth: 3,
      }),
      adjustmentClip({
        id: "B",
        trackId: "adjB",
        start: 0,
        timelineDuration: 100,
        depth: 3,
      }),
    ];
    const forest = deriveActiveAdjustmentGroups(tracks, clips, 50);

    expect(forest).toHaveLength(2);
    expect(forest[0].sourceClipId).toBe("A");
    expect(forest[0].trackIds).toEqual(["v1", "v2"]);
    expect(forest[0].children).toHaveLength(1);
    expect(forest[0].children[0].sourceClipId).toBe("B");
    expect(forest[0].children[0].trackIds).toEqual(["v1", "v2"]);

    expect(forest[1].sourceClipId).toBe("B");
    expect(forest[1].trackIds).toEqual(["v3"]);
    expect(forest[1].children).toEqual([]);
  });

  it("emits stable group ids across consecutive ticks when topology is unchanged", () => {
    const tracks = [
      adjustmentTrack("adj"),
      visualTrack("v1"),
      visualTrack("v2"),
    ];
    const clips = [
      adjustmentClip({
        id: "A",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 2,
      }),
    ];
    const t1 = deriveActiveAdjustmentGroups(tracks, clips, 10);
    const t2 = deriveActiveAdjustmentGroups(tracks, clips, 50);
    expect(t1[0].id).toBe(t2[0].id);
    expect(t1[0].id).toContain("A@");
  });

  it("emits different group ids when the contiguous run starts on a different track", () => {
    // Same source clip id "A" but different track layouts → different
    // first-track-in-run → different group ids.
    const tracksReachingBoth = [
      adjustmentTrack("adj"),
      visualTrack("v1"),
      visualTrack("v2"),
    ];
    const tracksReachingV2Only = [
      visualTrack("v1"),
      adjustmentTrack("adj"),
      visualTrack("v2"),
    ];
    const clip = adjustmentClip({
      id: "A",
      trackId: "adj",
      start: 0,
      timelineDuration: 100,
      depth: 2,
    });

    const both = deriveActiveAdjustmentGroups(tracksReachingBoth, [clip], 50);
    const v2Only = deriveActiveAdjustmentGroups(tracksReachingV2Only, [clip], 50);

    expect(both[0].trackIds).toEqual(["v1", "v2"]);
    expect(v2Only[0].trackIds).toEqual(["v2"]);
    expect(both[0].id).not.toBe(v2Only[0].id);
  });

  it("ignores clips with depth < 1", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips = [
      adjustmentClip({
        id: "A",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 0,
      }),
    ];
    const forest = deriveActiveAdjustmentGroups(tracks, clips, 50);
    expect(forest).toEqual([]);
  });

  it("carries the source clip's transformations through to the derived group", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const adjustment = adjustmentClip({
      id: "A",
      trackId: "adj",
      start: 0,
      timelineDuration: 100,
      depth: 1,
    });
    adjustment.transformations = [
      {
        id: "blur-1",
        type: "filter",
        isEnabled: true,
        parameters: { strength: 4 },
      },
    ];
    const forest = deriveActiveAdjustmentGroups(tracks, [adjustment], 50);
    expect(forest[0].transformations).toBe(adjustment.transformations);
    expect(forest[0].start).toBe(0);
    expect(forest[0].timelineDuration).toBe(100);
  });

  it("activates nested visual groups using the outer-warped time domain", () => {
    const tracks = [
      adjustmentTrack("adjA"),
      adjustmentTrack("adjB"),
      visualTrack("v1"),
    ];
    const clips = [
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
        depth: 1,
      }),
    ];

    const forest = deriveActiveAdjustmentGroups(tracks, clips, 80);
    expect(forest).toHaveLength(1);
    expect(forest[0].sourceClipId).toBe("A");
    expect(forest[0].children).toHaveLength(1);
    expect(forest[0].children[0].sourceClipId).toBe("B");
    expect(forest[0].children[0].trackIds).toEqual(["v1"]);
  });

  it("can use a caller-supplied per-track activation tick", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips = [
      adjustmentClip({
        id: "A",
        trackId: "adj",
        start: 0,
        timelineDuration: 50,
        sourceDuration: 100,
        depth: 1,
        transformations: [speedTransform(2)],
      }),
    ];

    expect(deriveActiveAdjustmentGroups(tracks, clips, 60)).toEqual([]);

    const forest = deriveActiveAdjustmentGroups(tracks, clips, 60, {
      activationTickByTrack: new Map([["v1", 47.5]]),
    });

    expect(forest).toHaveLength(1);
    expect(forest[0].sourceClipId).toBe("A");
    expect(forest[0].sampleTick).toBe(47.5);
  });

  it("splits tracks that need different group transform sample times", () => {
    const tracks = [
      adjustmentTrack("adj"),
      visualTrack("v1"),
      visualTrack("v2"),
    ];
    const clips = [
      adjustmentClip({
        id: "A",
        trackId: "adj",
        start: 0,
        timelineDuration: 50,
        sourceDuration: 100,
        depth: 2,
        transformations: [speedTransform(2)],
      }),
    ];

    const forest = deriveActiveAdjustmentGroups(tracks, clips, 60, {
      activationTickByTrack: new Map([
        ["v1", 47.5],
        ["v2", 40],
      ]),
    });

    expect(forest).toHaveLength(2);
    expect(forest[0].trackIds).toEqual(["v1"]);
    expect(forest[0].sampleTick).toBe(47.5);
    expect(forest[1].trackIds).toEqual(["v2"]);
    expect(forest[1].sampleTick).toBe(40);
  });
});
