import { describe, it, expect } from "vitest";
import {
  getMinimumClipDurationTicks,
  getResizeConstraints,
} from "../collision";
import { TICKS_PER_SECOND } from "../../constants";
import type { TimelineClip } from "../../../../types/TimelineTypes";

describe("getResizeConstraints with Nonlinear Time", () => {
  const baseClip: TimelineClip = {
    id: "target",
    trackId: "track_1",
    start: 100,
    timelineDuration: 50,
    offset: 0,
    sourceDuration: 200,
    transformations: [],
    name: "Target Clip",
    type: "video",
    transformedDuration: 200, // 1:1
    transformedOffset: 0,
    croppedSourceDuration: 200, // Add croppedSourceDuration
  };

  it("falls back to sourceDuration/offset when nonlinear fields are missing", () => {
    // Current state: Start 100, Dur 50. Source is 200.
    // Right resize max should be: sourceDuration (200) + start (100) - offset (0) = 300.
    const result = getResizeConstraints(baseClip, [], "right");
    expect(result.max).toBe(300);
  });

  it("uses transformedDuration when present (Speed Up 2x)", () => {
    // 2x Speed: Source 200 -> Transformed 100.
    const spedUpClip: TimelineClip = {
      ...baseClip,
      transformedDuration: 100,
      transformedOffset: 0,
    };

    // Right resize max should be: transformedDuration (100) + start (100) - startCrop (0) = 200.
    // It should NOT be 300.
    const result = getResizeConstraints(spedUpClip, [], "right");
    expect(result.max).toBe(200);
  });

  it("uses transformedOffset for left resize limits", () => {
    // Crop 20 ticks from start.
    const croppedClip: TimelineClip = {
      ...baseClip,
      offset: 20, // Legacy field
      transformedOffset: 20, // New field, matches legacy here
    };

    // Left resize limit (minStart):
    // start (100) - startCrop (20) = 80.
    const result = getResizeConstraints(croppedClip, [], "left");
    expect(result.min).toBe(80);
  });

  it("handles mismatched offset vs transformedOffset (e.g. variable speed)", () => {
    // Scenario: Source offset is 10s, but due to speed ramp, that represents only 5s (10 ticks? let's stick to units) on timeline.
    const nonlinearClip: TimelineClip = {
      ...baseClip,
      offset: 100, // Source domain
      transformedOffset: 50, // Timeline domain
    };

    // Left resize limit should use timeline domain crop:
    // start (100) - startCrop (50) = 50.
    const result = getResizeConstraints(nonlinearClip, [], "left");
    expect(result.min).toBe(50);
  });

  it("does not cap right resize for image clips", () => {
    const imageClip: TimelineClip = {
      ...baseClip,
      type: "image",
      sourceDuration: null,
      transformedDuration: 100,
      transformedOffset: 0,
    };

    const result = getResizeConstraints(imageClip, [], "right");
    expect(result.max).toBe(Infinity);
  });

  it("uses one frame as the minimum clip duration", () => {
    const minDuration = getMinimumClipDurationTicks(24);

    expect(minDuration).toBe(TICKS_PER_SECOND / 24);

    const leftResult = getResizeConstraints(baseClip, [], "left", minDuration);
    const rightResult = getResizeConstraints(baseClip, [], "right", minDuration);

    expect(leftResult.max).toBe(baseClip.start + baseClip.timelineDuration - minDuration);
    expect(rightResult.min).toBe(baseClip.start + minDuration);
  });
});
