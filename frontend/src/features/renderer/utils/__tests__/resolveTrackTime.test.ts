import { describe, expect, it, vi } from "vitest";
import type {
  AdjustmentTimelineClip,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import {
  buildTrackTimeResolver,
  trackTimeWarpsEqual,
} from "../../../timeline/time/resolveTrackTime";
import { extensionInterpolationRegistry } from "../../../transformations/animation";

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
    expect(resolver.resolvePresentationTick("v1", 120)).toBe(110);
    expect(resolver.resolvePresentationTick("v1", 230)).toBe(180);
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
    expect(resolver.resolvePresentationTick("v1", 170)).toBe(80);
  });

  it("resolves presentation ticks for nested adjustment tracks", () => {
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
    ];

    const resolver = buildTrackTimeResolver(tracks, clips);
    expect(resolver.resolvePresentationTick("adjB", 160)).toBe(80);
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

  describe("per-track warps", () => {
    const tracks: TimelineTrack[] = [adjustmentTrack("adj"), visualTrack("v1")];
    const speedClip = (factor: number) =>
      adjustmentClip({
        id: "A",
        trackId: "adj",
        start: 100,
        timelineDuration: 50,
        sourceDuration: 100,
        depth: 1,
        transformations: [speedTransform(factor)],
      });

    it("keeps mapping the values it was built from after an in-place edit", () => {
      const clip = speedClip(2);
      const warp = buildTrackTimeResolver(tracks, [clip]).forTrack("v1");
      expect(warp.resolveEffectiveTrackTick(110)).toBe(120);

      (clip.transformations[0].parameters as { factor: number }).factor = 4;

      // A later snapshot carrying the original values still matches, so the
      // warp it would reuse must still map those values.
      const restored = buildTrackTimeResolver(tracks, [speedClip(2)]).forTrack("v1");
      expect(trackTimeWarpsEqual(warp, restored)).toBe(true);
      expect(warp.resolveEffectiveTrackTick(110)).toBe(120);
    });

    it("differs when a speed provider registry changes", () => {
      const before = buildTrackTimeResolver(tracks, [speedClip(2)]).forTrack("v1");
      const revision = extensionInterpolationRegistry.getRevision();
      vi.spyOn(extensionInterpolationRegistry, "getRevision").mockReturnValue(revision + 1);
      try {
        const after = buildTrackTimeResolver(tracks, [speedClip(2)]).forTrack("v1");
        expect(trackTimeWarpsEqual(before, after)).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("compares unwarped tracks as equal regardless of providers", () => {
      const before = buildTrackTimeResolver(tracks, []).forTrack("v1");
      vi.spyOn(extensionInterpolationRegistry, "getRevision").mockReturnValue(-1);
      try {
        expect(trackTimeWarpsEqual(before, buildTrackTimeResolver(tracks, []).forTrack("v1"))).toBe(true);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });
});
