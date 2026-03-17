import { describe, it, expect } from "vitest";
import { solveTimelineDuration } from "../timeCalculation";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import { getInstantaneousSpeed } from "../timeCalculation";
import { TICKS_PER_SECOND } from "../../../timeline";

describe("Speed Integration Discrepancy", () => {
  it("shows significant error with low sample count on accelerating curves", () => {
    // 1. Setup: A clip with an accelerating speed curve (1x -> 4x) over 10 seconds of source time
    const startTicks = 0;
    const durationSeconds = 10;
    const points = [
      { time: 0, value: 1 },
      { time: durationSeconds, value: 4 },
    ];

    // We mock the clip structure needed for the calculation
    const mockClip: TimelineClip = {
      id: "test",
      trackId: "t1",
      start: startTicks,
      timelineDuration: durationSeconds * TICKS_PER_SECOND, // Initial guess, doesn't matter for solveTimelineDuration
      offset: 0,
      type: "video",
      transformations: [
        {
          id: "speed1",
          type: "speed",
          isEnabled: true,
          parameters: {
            factor: {
              type: "spline",
              points: points,
            },
          },
        },
      ],
    } as unknown as TimelineClip;

    // 2. Analytic Duration (The "True" Wall Clock time)
    // We want to play 'bufferDuration' amount of content.
    const bufferDuration = 1.0; // 1 second buffer
    const timelinePosition = 5 * TICKS_PER_SECOND; // Middle of the curve

    const trueWallDuration = solveTimelineDuration(
      mockClip,
      timelinePosition,
      bufferDuration,
    );

    // 3. Simulated Browser Playback (Linear Interpolation)
    // The browser takes the samples we give it and linearly interpolates between them to determine speed at any moment.
    // It implies the total duration is Integral(1/Speed(t) dt).

    function calculateSimulatedDuration(sampleCount: number) {
      // Generate the curve exactly as we do in useAudioTrack
      const speedCurve = new Float32Array(sampleCount);
      const timeStep =
        (trueWallDuration * TICKS_PER_SECOND) / (sampleCount - 1);

      for (let i = 0; i < sampleCount; i++) {
        const t = timelinePosition + i * timeStep;
        speedCurve[i] = getInstantaneousSpeed(mockClip, t);
      }

      // Now simulate the "Real" duration the browser would take to play the buffer
      // content = Integral(Speed(t) dt)
      // We want to find T_actual such that Integral_0^T_actual (LinearInterpSpeed(t)) dt = bufferDuration

      // However, the error manifests differently:
      // We TELL the browser to play for `trueWallDuration`.
      // The browser calculates: ContentPlayed = Integral_0^trueWallDuration (LinearInterpSpeed(t)) dt.
      // If ContentPlayed != bufferDuration, then we have a drift.
      // specifically, if ContentPlayed > bufferDuration, the browser finishes the buffer EARLY (underrun/gap).
      // if ContentPlayed < bufferDuration, the browser hasn't finished even though time is up (overlap).

      // Let's compute ContentPlayed using Trapezoidal rule on the samples
      let contentPlayed = 0;
      const dt = trueWallDuration / (sampleCount - 1);

      for (let i = 0; i < sampleCount - 1; i++) {
        const s0 = speedCurve[i];
        const s1 = speedCurve[i + 1];
        // Linear segment average speed
        const avgSpeed = (s0 + s1) / 2;
        contentPlayed += avgSpeed * dt;
      }

      return contentPlayed;
    }

    const contentPlayed30 = calculateSimulatedDuration(30);
    const error30 = contentPlayed30 - bufferDuration;

    // For an accelerating curve, Linear Interpolation (Trapezoid) consistently OVER-ESTIMATES the area under the concave curve?
    // Wait, Speed is increasing. 1 -> 4.
    // Is it Concave or Convex?
    // Monotone cubic spline of (0,1) to (10,4). Likely straight line or slightly curved depending on tangents.
    // If it's a straight line (Linear ramp), then Trapezoid is exact.
    // We need a curve where Trapezoid is NOT exact.
    // Monotone spline tries to preserve monotonicity.

    console.log(`True Wall Duration: ${trueWallDuration.toFixed(6)}s`);
    console.log(`Content Played (30 samples): ${contentPlayed30.toFixed(6)}s`);
    console.log(`Error (30 samples): ${(error30 * 1000).toFixed(4)}ms`);

    // We expect some error. If standard linear ramp, error should be near 0.
    // Let's make it more curved by adding a point.
    const pointsCurved = [
      { time: 0, value: 1 },
      { time: 5, value: 1.2 }, // Slow start
      { time: 10, value: 4 }, // Fast end (exponential-ish)
    ];
    mockClip.transformations![0].parameters.factor = {
      type: "spline",
      points: pointsCurved,
    };

    // Recalculate with curve
    const trueWallDurationCurved = solveTimelineDuration(
      mockClip,
      timelinePosition,
      bufferDuration,
    );

    // Re-run simulation
    // Update calculateSimulatedDuration to use the new trueWallDurationCurved logic inside...
    // (Actually the function captures scope variables which are now stale for the curve part if I don't being careful.
    //  Let's just copy logic inline for clarity).

    function getSimError(count: number, duration: number) {
      const speedCurve = new Float32Array(count);
      const timeStep = (duration * TICKS_PER_SECOND) / (count - 1);
      for (let i = 0; i < count; i++) {
        const t = timelinePosition + i * timeStep;
        speedCurve[i] = getInstantaneousSpeed(mockClip, t);
      }
      let played = 0;
      const dt = duration / (count - 1);
      for (let i = 0; i < count - 1; i++) {
        played += ((speedCurve[i] + speedCurve[i + 1]) / 2) * dt;
      }
      return played - bufferDuration;
    }

    const err30 = getSimError(30, trueWallDurationCurved);
    const err128 = getSimError(128, trueWallDurationCurved);

    console.log(`Error Curved (30): ${(err30 * 1000).toFixed(4)}ms`);
    console.log(`Error Curved (128): ${(err128 * 1000).toFixed(4)}ms`);

    // Expect 30 samples to have higher error than 128
    // 0.1ms is roughly audible phase issue, >1ms is gap.
    expect(Math.abs(err30)).toBeGreaterThan(Math.abs(err128));

    // We want to enforce a threshold.
    // If error > 1ms (0.001s), it's bad.
    // This assertion serves as our "Reproduction" - it passes if the problem exists (high error).
    // Wait, typically tests should pass if behavior is CORRECT.
    // But here I'm proving the implementation improvement.

    // Let's assert that 128 is "Good Enough" (< 0.05ms)
    // And 30 might be "Bad" (> 0.1ms) depending on the curve.

    expect(Math.abs(err128)).toBeLessThan(0.0001); // < 0.1ms error
  });
});
