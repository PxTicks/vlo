import { describe, it, expect } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import { getResizeConstraints } from "../collision";
import { TICKS_PER_SECOND } from "../../constants";

// This is the function we WILL implement in the destination logic
// For now, we define it here to verify the EXPECTED OUTPUTS logic before integrating.
const calculateSpeedUpdates = (clip: TimelineClip, newFactor: number) => {
  // 1. Calculate the Source Duration of the CURRENT visible content
  // Note: The logic below is what we WANT to implement.

  // Calculate Speed
  // If we are changing FROM 1x TO 2x.
  // We need to know the OLD speed? Assuming 1x for this test scenario.

  // New Duration = Duration / Factor?
  // Only if we want to "Compress" the timeline time.
  // User expectation: 10s duration -> 5s duration.
  const newDuration = Math.round(clip.timelineDuration / newFactor);

  // New Transformed Duration
  // Source 15s -> 7.5s
  const fullSourceDuration = clip.sourceDuration ?? clip.timelineDuration;
  const newTransformedDuration = Math.round(fullSourceDuration / newFactor);

  // New Start Crop Duration
  // Offset 5s -> 2.5s
  const newtransformedOffset = Math.round(clip.offset / newFactor);

  return {
    timelineDuration: newDuration,
    transformedDuration: newTransformedDuration,
    transformedOffset: newtransformedOffset,
  };
};

describe("Speed Workflow - User Scenario", () => {
  // Scenario:
  // 1. 15s Asset
  // 2. Drag in left handle 5s (Crop Start)
  // 3. Apply 2x Speed

  const TICK_5S = 5 * TICKS_PER_SECOND;
  const TICK_10S = 10 * TICKS_PER_SECOND;
  const TICK_15S = 15 * TICKS_PER_SECOND;

  // Step 1: Initial Clip (Full 15s)
  const initialClip: TimelineClip = {
    id: "test",
    trackId: "t1",
    start: 0,
    timelineDuration: TICK_15S,
    offset: 0,
    sourceDuration: TICK_15S,
    transformedDuration: TICK_15S,
    transformedOffset: 0,
    transformations: [],
    name: "Test",
    type: "video",
    croppedSourceDuration: TICK_15S, // Add croppedSourceDuration
  };

  // Step 2: Drag Left In 5s
  // Start moves to 5s. Duration becomes 10s. Offset becomes 5s.
  // transformedDuration/transformedOffset reflect 1x speed (unchanged ratio).
  // offset 5s -> startCrop 5s.
  const croppedClip: TimelineClip = {
    ...initialClip,
    start: TICK_5S,
    timelineDuration: TICK_10S, // 10s remaining
    offset: TICK_5S, // 5s skipped
    transformedOffset: TICK_5S,
    transformedDuration: TICK_15S,
  };

  it("calculates correct durations and constraints after 2x speed", () => {
    const speedFactor = 2;

    // --- ACT ---
    // Mimic the application of the speed transform
    const updates = calculateSpeedUpdates(croppedClip, speedFactor);

    const speedClip: TimelineClip = {
      ...croppedClip,
      ...updates,
      transformations: [
        {
          id: "speed",
          type: "speed",
          isEnabled: true,
          parameters: { factor: speedFactor },
        },
      ],
    };

    // --- VERIFY UPDATES ---

    // 1. Duration becomes 5s (10s content / 2)
    expect(speedClip.timelineDuration).toBe(TICK_5S);

    // 2. Transformed Duration (Source 15s / 2)
    expect(speedClip.transformedDuration).toBe(Math.round(TICK_15S / 2));

    // 3. Start Crop Duration (Offset 5s / 2)
    expect(speedClip.transformedOffset).toBe(Math.round(TICK_5S / 2));

    // --- VERIFY CONSTRAINTS ---

    // 4. "Left handle can be dragged back 2.5s"
    const leftConstraints = getResizeConstraints(speedClip, [], "left");

    // We expect min to be: Current Start (5s) - StartCrop (2.5s) = 2.5s.
    const expectedMin = TICK_5S - TICK_5S / 2; // 2.5s
    expect(leftConstraints.min).toBe(expectedMin);

    // 5. "Right handle should not be draggable"
    // Max limit should be: Start + TransformedDur - StartCrop
    // 5s + 7.5s - 2.5s = 10s.
    // Current End: Start(5s) + Duration(5s) = 10s.
    const rightConstraints = getResizeConstraints(speedClip, [], "right");
    const currentEnd = speedClip.start + speedClip.timelineDuration;
    expect(rightConstraints.max).toBe(currentEnd);
  });
});
