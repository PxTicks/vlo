import { describe, expect, it } from "vitest";
import type {
  StandardTimelineClip,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import {
  buildMarqueeClipBoxes,
  mergeMarqueeSelection,
  resolveMarqueeHits,
  type MarqueeClipBox,
} from "../marqueeSelection";
import { CLIP_HEIGHT, RULER_HEIGHT, TRACK_HEIGHT } from "../../constants";

function createTrack(id: string): TimelineTrack {
  return { id, label: id, isVisible: true, isLocked: false, isMuted: false };
}

function createClip(
  id: string,
  trackId: string,
  start: number,
  duration: number,
): StandardTimelineClip {
  return {
    id,
    trackId,
    type: "video",
    name: id,
    assetId: `asset_${id}`,
    start,
    timelineDuration: duration,
    offset: 0,
    croppedSourceDuration: duration,
    transformedOffset: 0,
    sourceDuration: duration,
    transformedDuration: duration,
    transformations: [],
  } as StandardTimelineClip;
}

/** Content-px top of the clip drawn in track row `index`. */
function clipTop(index: number): number {
  return RULER_HEIGHT + index * TRACK_HEIGHT + (TRACK_HEIGHT - CLIP_HEIGHT) / 2;
}

describe("buildMarqueeClipBoxes", () => {
  it("uses the drawn presentation footprint and skips masks and orphans", () => {
    const tracks = [createTrack("t1"), createTrack("t2")];
    const clips: TimelineClip[] = [
      createClip("a", "t1", 0, 100),
      createClip("b", "t2", 50, 100),
      {
        ...createClip("m", "t1", 0, 100),
        type: "mask",
      } as unknown as TimelineClip,
      createClip("orphan", "gone", 0, 100),
    ];
    const presentation = new Map([["a", { start: 0, end: 120 }]]);

    expect(buildMarqueeClipBoxes(clips, tracks, presentation)).toEqual([
      { id: "a", trackIndex: 0, start: 0, end: 120 },
      { id: "b", trackIndex: 1, start: 50, end: 150 },
    ]);
  });
});

describe("resolveMarqueeHits", () => {
  const boxes: MarqueeClipBox[] = [
    { id: "late-top", trackIndex: 0, start: 300, end: 400 },
    { id: "early-bottom", trackIndex: 1, start: 0, end: 100 },
    { id: "early-top", trackIndex: 0, start: 0, end: 100 },
  ];

  it("selects every clip the rectangle touches, earliest first", () => {
    expect(
      resolveMarqueeHits(
        {
          startTick: 50,
          endTick: 350,
          top: clipTop(0),
          bottom: clipTop(1) + 1,
        },
        boxes,
      ),
    ).toEqual(["early-top", "early-bottom", "late-top"]);
  });

  it("treats footprints as half-open horizontally", () => {
    expect(
      resolveMarqueeHits(
        { startTick: 100, endTick: 300, top: 0, bottom: 1000 },
        boxes,
      ),
    ).toEqual([]);
  });

  it("ignores the gap between clip rows", () => {
    const gapTop = clipTop(0) + CLIP_HEIGHT;
    expect(
      resolveMarqueeHits(
        { startTick: 0, endTick: 400, top: gapTop, bottom: clipTop(1) },
        boxes,
      ),
    ).toEqual([]);
  });
});

describe("mergeMarqueeSelection", () => {
  it("replaces the selection when there is no base", () => {
    expect(mergeMarqueeSelection([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("keeps the base order and primary clip, appending new hits", () => {
    expect(mergeMarqueeSelection(["c", "a"], ["a", "b"])).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});
