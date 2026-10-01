import { describe, expect, it } from "vitest";
import { pxToTicks } from "../../../../core/time/pixelGrid";
import { TRACK_HEADER_WIDTH } from "../../constants";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { TimelineClipPresentation } from "../../time/index";
import {
  buildVisibleTimelineClipIndex,
  clipsInVisibleTimelineRange,
  visiblePixelWindowForViewport,
  visibleTickRangeForPixelWindow,
} from "../visibleTimelineClips";

function clip(
  id: string,
  start: number,
  duration: number,
  type: "video" | "extension" = "video",
): TimelineClip {
  return {
    id,
    trackId: "track",
    start,
    timelineDuration: duration,
    type,
  } as unknown as TimelineClip;
}

describe("visible timeline clips", () => {
  it("keeps the pixel window stable through small boundary reversals and converts on zoom", () => {
    const contentWidth = 1200 - TRACK_HEADER_WIDTH;
    const first = visiblePixelWindowForViewport(0, 1200, null);
    expect(visiblePixelWindowForViewport(contentWidth * 0.7, 1200, first)).toBe(first);

    const shifted = visiblePixelWindowForViewport(contentWidth * 0.8, 1200, first);
    expect(shifted).not.toBe(first);
    expect(visiblePixelWindowForViewport(contentWidth * 0.7, 1200, shifted)).toBe(shifted);
    expect(visibleTickRangeForPixelWindow(shifted, 1).end).toBe(
      Math.ceil(pxToTicks(shifted.end, 1)),
    );
    expect(visibleTickRangeForPixelWindow(shifted, 2).end).toBe(
      Math.ceil(pxToTicks(shifted.end, 2)),
    );
  });

  it("uses presentation footprints, retains long overlaps, and pins selected clips", () => {
    const clips = [
      clip("long", 0, 1000),
      clip("old", 10, 10),
      clip("retimed", 10, 10),
      clip("later", 900, 10, "extension"),
    ];
    const presentation = new Map<string, TimelineClipPresentation>([
      ["retimed", { clipId: "retimed", trackId: "track", start: 500, end: 510, duration: 10 }],
    ]);
    const index = buildVisibleTimelineClipIndex(clips, presentation);

    expect(
      clipsInVisibleTimelineRange(index, { start: 490, end: 520 }, ["later"])
        .map((entry) => entry.id),
    ).toEqual(["long", "retimed", "later"]);
  });
});
