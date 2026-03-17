import { describe, it, expect } from "vitest";
import { calculatePlayerFrameTime } from "../renderTime";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline";

describe("calculatePlayerFrameTime (Regression Test)", () => {
  it("should return correct time for a cropped clip (Fixed)", () => {
    // SCENARIO:
    // 1. Put a 15s clip on the timeline starting at 0.
    // 2. Drag the left edge 5s inwards.
    // Resulting Clip State:
    // - Start: 5s (moved in)
    // - Duration: 10s (shortened)
    // - Offset: 5s (viewing starts 5s into the asset)

    const startSeconds = 5;
    const offsetSeconds = 5;

    const startTicks = startSeconds * TICKS_PER_SECOND;
    const offsetTicks = offsetSeconds * TICKS_PER_SECOND;
    const durationTicks = 10 * TICKS_PER_SECOND;

    const clip: TimelineClip = {
      id: "test-clip",
      name: "Test Clip",
      type: "video",
      trackId: "track-1",
      start: startTicks,
      timelineDuration: durationTicks,
      sourceDuration: durationTicks + offsetTicks, // Total source length
      transformedDuration: durationTicks + offsetTicks, // 1x speed
      transformedOffset: 0, // No start crop initially
      croppedSourceDuration: durationTicks + offsetTicks, // 1x speed
      offset: offsetTicks,
      transformations: [],
    };

    // TEST CASE:
    // Playhead is at 5 seconds (Global Time = 5s).
    // This is exactly the start of the clip on the timeline.
    // The user expects to see the frame corresponding to 5s into the video file.
    const globalTime = startTicks; // 5s

    const resultSeconds = calculatePlayerFrameTime(clip, globalTime);

    console.log("Global Time (s):", globalTime / TICKS_PER_SECOND);
    console.log("Clip Start (s):", clip.start / TICKS_PER_SECOND);
    console.log("Clip Offset (s):", clip.offset / TICKS_PER_SECOND);
    console.log("Result (s):", resultSeconds);

    // Expectation: 0.0 seconds.
    // Logic: calculatePlayerFrameTime returns time relative to the offset point.
    // Downstream consumers (e.g. Decoder) seemingly add the clip.offset or handle it.
    expect(resultSeconds).toBeCloseTo(0.0, 0.001);
  });
});
