import { describe, it, expect } from "vitest";
import {
  calculateClipTime,
  getSegmentContentDuration,
} from "../utils/timeCalculation";
import type { TimelineClip, ClipTransform } from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../timeline";

describe("Speed Stacking Math", () => {
  // --- Setup ---
  // 10 second source clip.
  const baseClip: TimelineClip = {
    id: "c1",
    trackId: "t1",
    start: 0,
    timelineDuration: 10 * TICKS_PER_SECOND,
    offset: 0,
    sourceDuration: 10 * TICKS_PER_SECOND,
    transformedDuration: 10 * TICKS_PER_SECOND,
    transformedOffset: 0,
    croppedSourceDuration: 10 * TICKS_PER_SECOND, // Add croppedSourceDuration
    name: "Test",
    type: "video",
    transformations: [],
  };

  it("handles basic 2x speed (phase shift 0)", () => {
    const clip: TimelineClip = {
      ...baseClip,
      transformations: [
        {
          id: "t1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
      ] as ClipTransform[],
    };

    // At 1s Timeline -> 2s Source
    const t1 = calculateClipTime(clip, 1 * TICKS_PER_SECOND);
    expect(t1).toBe(2 * TICKS_PER_SECOND);

    // Delta Check: 1s Visual Delta -> 2s Source Delta
    const delta = getSegmentContentDuration(clip, 0, 1 * TICKS_PER_SECOND);
    expect(delta).toBe(2 * TICKS_PER_SECOND);
  });

  it("handles 2x speed with Start Crop (Phase Shift) - Correct usage", () => {
    // Correct Usage: If we cropped 2s of 2x timeline, offset must be 4s.
    const clip: TimelineClip = {
      ...baseClip,
      start: 0,
      offset: 4 * TICKS_PER_SECOND, // Source Start
      transformedOffset: 2 * TICKS_PER_SECOND, // Phase Shift
      transformations: [
        {
          id: "t1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
      ] as ClipTransform[],
    };

    // T=0. Should be Offset (4s).
    const t0 = calculateClipTime(clip, 0);
    expect(t0).toBe(4 * TICKS_PER_SECOND);

    // T=1s. Should be Offset + 2s = 6s.
    const t1 = calculateClipTime(clip, 1 * TICKS_PER_SECOND);
    expect(t1).toBe(6 * TICKS_PER_SECOND);
  });

  it("handles Spline Speed Ramp with Crop (Phase Shift verification)", () => {
    // Spline: Linear Ramp from 1x to 3x over 10s.
    // s(t) = 1 + 0.2t.
    // Integral D(t) = t + 0.1t^2.

    // Points: (0, 1), (10, 3).
    const splinePoints = [
      { time: 0, value: 1 },
      { time: 10 * TICKS_PER_SECOND, value: 3 },
    ];

    // Case 1: No Crop. T=0 to T=1.
    // D(1) - D(0) = (1 + 0.1) - 0 = 1.1s.
    const clipNoCrop: TimelineClip = {
      ...baseClip,
      transformations: [
        {
          id: "t1",
          type: "speed",
          isEnabled: true,
          parameters: {
            factor: { type: "spline", points: splinePoints },
          },
        },
      ] as ClipTransform[],
    };

    // Check Delta at start (approx 1.1s)
    const d0 = getSegmentContentDuration(clipNoCrop, 0, 1 * TICKS_PER_SECOND);
    // We use MonotoneCubicSpline, which matches linear for 2 points?
    // MCS usually curves. But let's check values are in ballpark range (1.0 vs >2.0).
    expect(d0 / TICKS_PER_SECOND).toBeCloseTo(1.1, 0.5); // Loose tolerance for MCS

    // Case 2: Crop 5s.
    // t_spline = 5. s(5) = 2.0.
    // D(6) - D(5).
    // D(6) = 6 + 0.1(36) = 9.6.
    // D(5) = 5 + 0.1(25) = 7.5.
    // Delta = 2.1.

    const clipCropped: TimelineClip = {
      ...baseClip,
      transformedOffset: 5 * TICKS_PER_SECOND,
      transformations: [
        {
          id: "t1",
          type: "speed",
          isEnabled: true,
          parameters: {
            factor: { type: "spline", points: splinePoints },
          },
        },
      ] as ClipTransform[],
    };

    const dCrop = getSegmentContentDuration(
      clipCropped,
      0,
      1 * TICKS_PER_SECOND,
    );
    expect(dCrop / TICKS_PER_SECOND).toBeGreaterThan(1.8); // Expect ~2.1

    // If startCrop was ignored, dCrop would be same as d0 (1.1).
    // Since 2.1 >> 1.1, this confirms Phase Shift is working.
  });

  it("handles Stacked Speed (2x * 2x = 4x)", () => {
    const clip: TimelineClip = {
      ...baseClip,
      transformations: [
        {
          id: "t1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
        {
          id: "t2",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
      ] as ClipTransform[],
    };

    // 1s Timeline -> 4s Source
    const t1 = calculateClipTime(clip, 1 * TICKS_PER_SECOND);
    expect(t1).toBe(4 * TICKS_PER_SECOND);
  });

  it("handles Stacked Cancellation (2x * 0.5x = 1x)", () => {
    const clip: TimelineClip = {
      ...baseClip,
      transformations: [
        {
          id: "t1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
        {
          id: "t2",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 0.5 },
        },
      ] as ClipTransform[],
    };

    // 1s Timeline -> 1s Source
    const t1 = calculateClipTime(clip, 1 * TICKS_PER_SECOND);
    expect(t1).toBe(1 * TICKS_PER_SECOND);
  });
});
