import { describe, expect, it } from "vitest";
import type {
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import {
  buildTimelineClipPresentationLookup,
  computeQuantizedPresentation,
} from "../clipPresentation";
import { ticksPerFrame } from "../frameGrid";

const FPS = 30;
const TPF = ticksPerFrame(FPS); // 3200 ticks per frame at 30fps

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

function videoClip(
  id: string,
  trackId: string,
  start: number,
  dur: number,
): TimelineClip {
  return {
    id,
    type: "video",
    name: id,
    trackId,
    assetId: `asset-${id}`,
    start,
    timelineDuration: dur,
    sourceDuration: dur,
    transformedDuration: dur,
    transformedOffset: 0,
    croppedSourceDuration: dur,
    offset: 0,
    transformations: [],
  };
}

describe("computeQuantizedPresentation", () => {
  it("leaves an already-frame-aligned footprint unchanged", () => {
    expect(computeQuantizedPresentation(0, 2 * TPF, FPS)).toEqual({
      startTick: 0,
      endTick: 2 * TPF,
      durationTicks: 2 * TPF,
    });
  });

  it("does NOT over-ceil a frame-aligned boundary perturbed by float error", () => {
    // The exact gotcha: a frame-snapped placement nudged by FP dust must stay
    // on its frame, never jump to the next.
    const q = computeQuantizedPresentation(TPF + 1e-6, 2 * TPF + 1e-6, FPS);
    expect(q.startTick).toBe(TPF);
    expect(q.endTick).toBe(2 * TPF);
  });

  it("ceils a genuinely fractional end up (never truncates the last frame)", () => {
    // raw end sits mid-frame-2 -> include all of frame 2.
    const q = computeQuantizedPresentation(0, TPF + 1000, FPS);
    expect(q.endTick).toBe(2 * TPF);
    expect(q.durationTicks).toBe(2 * TPF);
  });

  it("ceils a fractional start up", () => {
    const q = computeQuantizedPresentation(TPF + 500, 3 * TPF, FPS);
    expect(q.startTick).toBe(2 * TPF);
  });

  it("guarantees at least one frame of duration", () => {
    const q = computeQuantizedPresentation(2 * TPF, 2 * TPF, FPS);
    expect(q.durationTicks).toBe(TPF);
    expect(q.endTick).toBe(3 * TPF);
  });

  it("keeps adjacent clips abutting across a shared fractional boundary", () => {
    // A ends and B starts at the same fractional tick 2.7 frames (continuity
    // from the resolver). Consistent ceiling maps both to frame 3 -> abut.
    const sharedRaw = 2.7 * TPF;
    const a = computeQuantizedPresentation(0, sharedRaw, FPS);
    const b = computeQuantizedPresentation(sharedRaw, 5 * TPF, FPS);
    expect(a.endTick).toBe(3 * TPF);
    expect(b.startTick).toBe(3 * TPF);
    expect(a.endTick).toBe(b.startTick); // no gap, no overlap
  });
});

describe("findActiveClipAt — half-open [startTick, endTick) on the frame grid", () => {
  const tracks = [visualTrack("v1")];
  const clips = [
    videoClip("A", "v1", 0, TPF), // frame 0
    videoClip("B", "v1", TPF, TPF), // frame 1
  ];
  const lookup = buildTimelineClipPresentationLookup(tracks, clips, FPS);

  it("assigns a shared boundary to the LATER clip (the one starting there)", () => {
    expect(lookup.findActiveClipAt("v1", TPF)?.clip.id).toBe("B");
  });

  it("renders the first frame of a clip that starts exactly on a boundary (gotcha)", () => {
    // B starts exactly at tick TPF — that frame must be B's, and frame 0 is A's.
    expect(lookup.findActiveClipAt("v1", 0)?.clip.id).toBe("A");
    expect(lookup.findActiveClipAt("v1", TPF - 1)?.clip.id).toBe("A");
    expect(lookup.findActiveClipAt("v1", TPF)?.clip.id).toBe("B");
  });

  it("returns null past the last clip's end", () => {
    expect(lookup.findActiveClipAt("v1", 2 * TPF)).toBeNull();
  });
});
