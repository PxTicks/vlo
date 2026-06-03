import { describe, it, expect } from "vitest";
import {
  buildClipGraphTimeAxis,
  clipSourceTimeToVisual,
  clipSourceTimeWindow,
  clipVisualToSourceTime,
  presentationToClipSourceTime,
} from "../clipTimeDomains";
import type {
  AdjustmentTimelineClip,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline";

function makeClip(transformations: ClipTransform[] = []): TimelineClip {
  return {
    id: "c1",
    trackId: "t1",
    assetId: "asset_c1",
    start: 0,
    timelineDuration: 10 * TICKS_PER_SECOND,
    offset: 0,
    sourceDuration: 10 * TICKS_PER_SECOND,
    transformedDuration: 10 * TICKS_PER_SECOND,
    transformedOffset: 0,
    croppedSourceDuration: 10 * TICKS_PER_SECOND,
    name: "Test",
    type: "video",
    transformations,
  } as TimelineClip;
}

const speed = (factor: ClipTransform["parameters"]["factor"]): ClipTransform =>
  ({ id: "s1", type: "speed", isEnabled: true, parameters: { factor } }) as ClipTransform;

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
    transformations: [speed(2)],
    depth: 1,
  };
}

describe("clipTimeDomains", () => {
  it("clipVisualToSourceTime pulls a clip-local visual tick to source through speed", () => {
    const clip = makeClip([speed(2)]);
    // 2x: 1s of visual playback consumes 2s of source.
    expect(clipVisualToSourceTime(clip, 1 * TICKS_PER_SECOND)).toBe(
      2 * TICKS_PER_SECOND,
    );
  });

  it("round-trips source <-> visual time", () => {
    const clip = makeClip([speed(2)]);
    const sourceTimeTicks = 4 * TICKS_PER_SECOND;
    const visual = clipSourceTimeToVisual(clip, sourceTimeTicks);
    expect(visual).toBe(2 * TICKS_PER_SECOND);
    expect(clipVisualToSourceTime(clip, visual)).toBeCloseTo(
      sourceTimeTicks,
      3,
    );
  });

  it("clipSourceTimeWindow is the clip's source window (speed-independent)", () => {
    const noSpeed = clipSourceTimeWindow(makeClip());
    const withSpeed = clipSourceTimeWindow(makeClip([speed(3)]));
    expect(withSpeed).toEqual(noSpeed);
    expect(noSpeed).toEqual({
      minTime: 0,
      duration: 10 * TICKS_PER_SECOND,
    });
  });

  it("FRAME TRUTH: source-media time is stored identically while its visual position reschedules with speed", () => {
    const sourceTimeTicks = 5 * TICKS_PER_SECOND;
    const slow = makeClip([speed(2)]);
    const fast = makeClip([speed(4)]);

    // Storage (the frame's anchor) is the same source time regardless of speed.
    // Only WHEN it is presented changes — the display reschedules, the data does not.
    expect(clipSourceTimeToVisual(slow, sourceTimeTicks)).toBe(
      2.5 * TICKS_PER_SECOND,
    );
    expect(clipSourceTimeToVisual(fast, sourceTimeTicks)).toBe(
      1.25 * TICKS_PER_SECOND,
    );
  });

  it("presentationToClipSourceTime maps presentation through a 2x adjustment", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clip = makeClip();
    const clips: TimelineClip[] = [
      adjustmentClip(),
      { ...clip, id: "video-1", trackId: "v1", timelineDuration: 100 },
    ];

    expect(
      presentationToClipSourceTime(
        { tracks, clips, fps: TICKS_PER_SECOND },
        clips[1],
        25,
      ),
    ).toBe(50);
  });

  it("axis round-trips and is linear under a constant speed", () => {
    const axis = buildClipGraphTimeAxis(makeClip([speed(2)]));
    expect(axis.sourceToNorm(0)).toBeCloseTo(0, 6);
    expect(axis.sourceToNorm(10 * TICKS_PER_SECOND)).toBeCloseTo(1, 6);
    // Constant speed -> linear axis: source midpoint sits at norm 0.5.
    expect(axis.sourceToNorm(5 * TICKS_PER_SECOND)).toBeCloseTo(0.5, 6);
    expect(axis.normToSource(0.5)).toBeCloseTo(5 * TICKS_PER_SECOND, 3);
  });

  it("axis WARPS (non-linearly) under a speed ramp", () => {
    // Ramp 1x -> 3x over the source window. The visual axis compresses later
    // source time, so the source midpoint lands past the visual midpoint.
    const ramp = buildClipGraphTimeAxis(
      makeClip([
        speed({
          type: "spline",
          points: [
            { time: 0, value: 1 },
            { time: 10 * TICKS_PER_SECOND, value: 3 },
          ],
        }),
      ]),
    );
    const midNorm = ramp.sourceToNorm(5 * TICKS_PER_SECOND);
    // Endpoints still pinned.
    expect(ramp.sourceToNorm(0)).toBeCloseTo(0, 6);
    expect(ramp.sourceToNorm(10 * TICKS_PER_SECOND)).toBeCloseTo(1, 6);
    // The defining property: NOT linear (would be 0.5), and round-trips.
    expect(Math.abs(midNorm - 0.5)).toBeGreaterThan(0.05);
    expect(ramp.normToSource(midNorm)).toBeCloseTo(5 * TICKS_PER_SECOND, 1);
  });
});
