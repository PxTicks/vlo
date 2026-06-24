import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../../../types/TimelineTypes";
import { compareResolvedJobToLegacy } from "../FrameJobResolver";
import type { ResolvedClipFrameJob } from "../framePlanningTypes";

const clip = { id: "clip-1" } as unknown as TimelineClip;

function job(overrides: Partial<ResolvedClipFrameJob> = {}): ResolvedClipFrameJob {
  return {
    id: "1:t1:clip-1",
    trackId: "t1",
    activeClip: clip,
    effectiveTrackTick: 120,
    rawClipTick: 0,
    sourceFrame: {
      key: "clip-1:120",
      generation: 1,
    } as ResolvedClipFrameJob["sourceFrame"],
    maskClips: [],
    logicalDimensions: { width: 1920, height: 1080 },
    contentSize: { width: 640, height: 360 },
    fps: 30,
    ...overrides,
  };
}

describe("compareResolvedJobToLegacy", () => {
  it("reports no mismatches when the planned job matches the legacy resolution", () => {
    const mismatches = compareResolvedJobToLegacy({
      job: job(),
      trackId: "t1",
      legacyActiveClip: clip,
      legacyEffectiveTick: 120,
      legacySourceFrameKey: "clip-1:120",
      legacyMaskClips: [],
      legacyVisible: true,
    });
    expect(mismatches).toEqual([]);
  });

  it("detects a divergent active clip, effective tick, and source frame", () => {
    const mismatches = compareResolvedJobToLegacy({
      job: job(),
      trackId: "t1",
      legacyActiveClip: { id: "clip-2" } as unknown as TimelineClip,
      legacyEffectiveTick: 121,
      legacySourceFrameKey: "clip-1:121",
      legacyMaskClips: [],
      legacyVisible: true,
    });
    expect(mismatches.map((m) => m.field).sort()).toEqual([
      "activeClip",
      "effectiveTick",
      "sourceFrame",
    ]);
  });

  it("flags a blank track that legacy considered visible", () => {
    const mismatches = compareResolvedJobToLegacy({
      job: null,
      trackId: "t1",
      legacyActiveClip: clip,
      legacyEffectiveTick: 120,
      legacyMaskClips: [],
      legacyVisible: true,
    });
    expect(mismatches.map((m) => m.field)).toContain("visibility");
    expect(mismatches.map((m) => m.field)).toContain("activeClip");
  });
});
