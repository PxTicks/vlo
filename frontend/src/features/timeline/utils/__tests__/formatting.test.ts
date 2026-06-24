import { describe, expect, it } from "vitest";
import type { ClipType, TrackType } from "../../../../types/TimelineTypes";
import {
  getTrackColor,
  getTrackTypeFromClip,
  getTrackTypeFromClipType,
} from "../formatting";

describe("timeline formatting", () => {
  it.each([
    ["video", "visual"],
    ["image", "visual"],
    ["text", "visual"],
    ["shape", "visual"],
    ["audio", "audio"],
    ["adjustment", "adjustment"],
    ["mask", "visual"],
  ] satisfies Array<[ClipType, TrackType]>)(
    "maps %s clips to the %s track type",
    (clipType, expectedTrackType) => {
      expect(getTrackTypeFromClipType(clipType)).toBe(expectedTrackType);
      expect(getTrackTypeFromClip({ type: clipType })).toBe(expectedTrackType);
    },
  );

  it.each([
    ["visual", "#3f51b5"],
    ["audio", "#f50057"],
    ["effects", "#9c27b0"],
    ["prompt", "#ff9800"],
    ["adjustment", "#5fa8ff"],
  ] satisfies Array<[TrackType, string]>)(
    "maps %s tracks to their display color",
    (trackType, expectedColor) => {
      expect(getTrackColor(trackType)).toBe(expectedColor);
    },
  );
});
