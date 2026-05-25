import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline";
import {
  collectSectionKeyframes,
  getDefaultSectionId,
  getDynamicSectionId,
  getSectionGroupKeyframeColor,
} from "../sectionKeyframes";

const baseClip: TimelineClip = {
  id: "clip_1",
  trackId: "track_1",
  start: 0,
  type: "video",
  assetId: "asset_1",
  name: "Clip 1",
  sourceDuration: 10 * TICKS_PER_SECOND,
  transformedDuration: 10 * TICKS_PER_SECOND,
  transformedOffset: 0,
  timelineDuration: 10 * TICKS_PER_SECOND,
  croppedSourceDuration: 10 * TICKS_PER_SECOND,
  offset: 0,
  transformations: [],
};

describe("sectionKeyframes", () => {
  it("collects keyframes from all groups in a default section with group colors", () => {
    const clip: TimelineClip = {
      ...baseClip,
      transformations: [
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: { x: 0, y: 0 },
          keyframeTimes: [120, 360],
        },
        {
          id: "scale_1",
          type: "scale",
          isEnabled: true,
          parameters: { x: 1, y: 1 },
          keyframeTimes: [240],
        },
        {
          id: "rotation_1",
          type: "rotation",
          isEnabled: true,
          parameters: { angle: 0 },
          keyframeTimes: [480],
        },
      ],
    };

    const markers = collectSectionKeyframes(clip, getDefaultSectionId("layout"));

    expect(markers).toHaveLength(4);
    expect(markers.map((marker) => marker.groupId)).toEqual([
      "position",
      "scale",
      "position",
      "rotation",
    ]);

    const colorsByGroup = new Map(
      markers.map((marker) => [marker.groupId, marker.color]),
    );
    expect(colorsByGroup.get("position")).toBe(getSectionGroupKeyframeColor(1));
    expect(colorsByGroup.get("scale")).toBe(getSectionGroupKeyframeColor(2));
    expect(colorsByGroup.get("rotation")).toBe(getSectionGroupKeyframeColor(3));
  });

  it("collects keyframes for a dynamic section and uses the first group color", () => {
    const clip: TimelineClip = {
      ...baseClip,
      transformations: [
        {
          id: "speed_1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 1 },
          keyframeTimes: [100, 200],
        },
      ],
    };

    const markers = collectSectionKeyframes(clip, getDynamicSectionId("speed_1"));

    expect(markers).toHaveLength(2);
    expect(markers.every((marker) => marker.groupId === "speed")).toBe(true);
    expect(markers.every((marker) => marker.color === "#ffb000")).toBe(true);
  });

  it("uses off-white for the fourth group color slot", () => {
    expect(getSectionGroupKeyframeColor(3)).toBe("#f5f5f5");
  });

  it("suppresses position keyframe markers when a position path is active", () => {
    const clip: TimelineClip = {
      ...baseClip,
      transformations: [
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: {
            x: 0,
            y: 0,
            path: {
              type: "path2d",
              curve: "centripetal_catmull_rom",
              controlPoints: [
                { x: 0, y: 0 },
                { x: 100, y: 0 },
              ],
              timing: {
                type: "spline",
                points: [
                  { time: 0, value: 0 },
                  { time: 1, value: 1 },
                ],
              },
            },
          },
          keyframeTimes: [120, 360],
        },
        {
          id: "scale_1",
          type: "scale",
          isEnabled: true,
          parameters: { x: 1, y: 1 },
          keyframeTimes: [240],
        },
      ],
    };

    const markers = collectSectionKeyframes(clip, getDefaultSectionId("layout"));

    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      groupId: "scale",
      inputTime: 240,
      visualTime: 240,
    });
  });
});
