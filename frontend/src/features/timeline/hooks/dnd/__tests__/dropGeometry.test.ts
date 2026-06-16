import { describe, expect, it } from "vitest";
import {
  getInterstitialGapIndex,
  getSynthesizedTrackTop,
  getTickFromDragLeft,
  getTrackIndexAtY,
  resolveTimelineDropTarget,
} from "../dropGeometry";

// Mirrors the timeline constants the module is built on:
//   TRACK_HEIGHT = 60, RULER_HEIGHT = 24, TRACK_HEADER_WIDTH = 80,
//   SNAP_THRESHOLD_PX = 10, GHOST_CLIP_HEIGHT = 50, ASSET_DRAG_OFFSET_X = 60.

const identity = (n: number) => n;

describe("getTickFromDragLeft", () => {
  it("subtracts the track header and adds scroll, then maps to ticks", () => {
    // relativeX = 180 - 0 + 0 - 80 = 100
    expect(getTickFromDragLeft(180, 0, 0, identity)).toBe(100);
    // scroll offset is added
    expect(getTickFromDragLeft(180, 0, 40, identity)).toBe(140);
    // container offset is subtracted
    expect(getTickFromDragLeft(180, 30, 0, identity)).toBe(70);
  });

  it("clamps negative positions to tick 0", () => {
    // relativeX = 50 - 0 + 0 - 80 = -30 -> 0
    expect(getTickFromDragLeft(50, 0, 0, identity)).toBe(0);
  });
});

describe("getTrackIndexAtY", () => {
  it("resolves the row under the cursor", () => {
    // relativeY = 34 - 0 + 0 - 24 = 10 -> floor(10/60) = 0
    expect(getTrackIndexAtY(34, 0, 600, 0, 3)).toBe(0);
    // relativeY = 89 - 24 = 65 -> floor(65/60) = 1
    expect(getTrackIndexAtY(89, 0, 600, 0, 3)).toBe(1);
  });

  it("returns -1 above the first row (inside the ruler)", () => {
    expect(getTrackIndexAtY(10, 0, 600, 0, 3)).toBe(-1);
  });

  it("returns -1 past the last track", () => {
    // relativeY = 209 - 24 = 185 -> floor = 3 >= trackCount 3
    expect(getTrackIndexAtY(209, 0, 600, 0, 3)).toBe(-1);
  });

  it("returns -1 outside the container bounds", () => {
    expect(getTrackIndexAtY(700, 0, 600, 0, 3)).toBe(-1);
  });

  it("accounts for scrollTop", () => {
    // relativeY = 34 - 0 + 60 - 24 = 70 -> floor(70/60) = 1
    expect(getTrackIndexAtY(34, 0, 600, 60, 3)).toBe(1);
  });
});

describe("getSynthesizedTrackTop", () => {
  it("places the row top below the ruler, offset by scroll", () => {
    // 0 - 0 + 24 + 1*60 = 84
    expect(getSynthesizedTrackTop(0, 0, 1)).toBe(84);
    // scroll shifts it up: 0 - 30 + 24 + 1*60 = 54
    expect(getSynthesizedTrackTop(0, 30, 1)).toBe(54);
  });
});

describe("getInterstitialGapIndex", () => {
  const trackTop = 84;
  const trackBottom = 144;
  const trackHeight = 60; // threshold = 21

  it("inserts above when near the top edge", () => {
    expect(getInterstitialGapIndex(90, trackTop, trackBottom, trackHeight, 1)).toBe(1);
  });

  it("inserts below when near the bottom edge", () => {
    expect(getInterstitialGapIndex(140, trackTop, trackBottom, trackHeight, 1)).toBe(2);
  });

  it("drops on the row when near the middle", () => {
    expect(
      getInterstitialGapIndex(114, trackTop, trackBottom, trackHeight, 1),
    ).toBeNull();
  });
});

describe("resolveTimelineDropTarget", () => {
  const base = {
    containerLeftPx: 0,
    containerTopPx: 0,
    containerBottomPx: 600,
    scrollLeft: 0,
    scrollTop: 0,
    trackCount: 3,
    ghostDurationTicks: 100,
    ticksToPx: identity,
    pxToTicks: identity,
  } as const;

  it("derives the start tick from the ghost's left edge (cursor - 60 - header)", () => {
    // ghost.x = 200 - 60 = 140; rawStart = 140 - 80 = 60
    const result = resolveTimelineDropTarget({
      ...base,
      cursorX: 200,
      cursorY: 54, // middle of track 0
    });
    expect(result.rawStartTicks).toBe(60);
    expect(result.trackIndex).toBe(0);
    expect(result.interstitialGapIndex).toBeNull();
    expect(result.snappedStartTicks).toBeNull();
  });

  it("flags an interstitial insert when the ghost centre is near a boundary", () => {
    // cursorY 34 -> ghost centre 34, 10px into track 0 (< 21 threshold) -> gap 0
    const result = resolveTimelineDropTarget({
      ...base,
      cursorX: 200,
      cursorY: 34,
    });
    expect(result.trackIndex).toBe(0);
    expect(result.interstitialGapIndex).toBe(0);
  });

  it("applies clip-edge snapping when a snap point is within threshold", () => {
    // rawStart 60, snap point 50 is 10px away (== threshold) -> snaps to 50
    const result = resolveTimelineDropTarget({
      ...base,
      cursorX: 200,
      cursorY: 54,
      snap: { points: [50], enabled: true },
    });
    expect(result.snappedStartTicks).toBe(50);
    expect(result.snapTick).toBe(50);
  });

  it("does not snap when disabled or out of range", () => {
    const disabled = resolveTimelineDropTarget({
      ...base,
      cursorX: 200,
      cursorY: 54,
      snap: { points: [50], enabled: false },
    });
    expect(disabled.snappedStartTicks).toBeNull();

    const farPoint = resolveTimelineDropTarget({
      ...base,
      cursorX: 200,
      cursorY: 54,
      snap: { points: [0], enabled: true },
    });
    expect(farPoint.snappedStartTicks).toBeNull();
  });

  it("returns trackIndex -1 below the stack", () => {
    const result = resolveTimelineDropTarget({
      ...base,
      cursorX: 200,
      cursorY: 590, // past 3 tracks (ends at 24 + 180 = 204)
    });
    expect(result.trackIndex).toBe(-1);
    expect(result.interstitialGapIndex).toBeNull();
  });
});
