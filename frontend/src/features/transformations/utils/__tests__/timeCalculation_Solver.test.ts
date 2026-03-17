import { solveTimelineDuration, calculateClipTime } from "../timeCalculation";
import type {
  TimelineClip,
  ClipTransform,
} from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline";

describe("solveTimelineDuration (Analytic)", () => {
  // Helper to create a dummy clip
  function createClip(
    transformations: Partial<ClipTransform>[] = [],
  ): TimelineClip {
    return {
      id: "test",
      trackId: "t1",
      assetId: "a1",
      start: 0,
      offset: 0,
      timelineDuration: 10 * TICKS_PER_SECOND,
      type: "video",
      transformations: transformations.map((t) => ({ ...t, isEnabled: true })),
    } as TimelineClip;
  }

  it("handles linear speed (2x)", () => {
    const clip = createClip([{ type: "speed", parameters: { factor: 2.0 } }]);

    // At 2x speed, playing 1 second of content takes 0.5 seconds of wall time.
    const contentDuration = 1.0;
    const wallDuration = solveTimelineDuration(clip, 0, contentDuration);

    expect(wallDuration).toBeCloseTo(0.5, 4);
  });

  it("handles linear speed (0.5x)", () => {
    const clip = createClip([{ type: "speed", parameters: { factor: 0.5 } }]);

    // At 0.5x speed, playing 1 second of content takes 2.0 seconds of wall time.
    const contentDuration = 1.0;
    const wallDuration = solveTimelineDuration(clip, 0, contentDuration);

    expect(wallDuration).toBeCloseTo(2.0, 4);
  });

  it("handles complex spline speed", () => {
    // Define a spline that ramps 1x -> 2x over 1 second of SOURCE time
    // Value at t=0 is 1. Value at t=1 is 2.
    const points = [
      { time: 0, value: 1 },
      { time: 1, value: 2 },
    ];

    const clip = createClip([
      { type: "speed", parameters: { factor: { type: "spline", points } } },
    ]);

    // We want to play 1 second of content (Source 0 to 1).
    // Speed ramps 1->2. Avg speed approx 1.5?
    // Timeline Duration = Integral (1/Speed) dt.
    // 1 / (1 + t) integration?
    // Spline is cubic, but lets assume linear ramp for mental check.
    // Speed(t) = 1 + t.
    // dt_timeline = (1 / (1+t)) dt_source.
    // T = ln(1+t) from 0 to 1 = ln(2) = 0.693s.

    const contentDuration = 1.0;
    const wallDuration = solveTimelineDuration(clip, 0, contentDuration);

    // Monotone spline might not be perfectly linear, but close.
    expect(wallDuration).toBeCloseTo(0.693, 1);
  });

  it("is consistent with calculateClipTime (Round Trip)", () => {
    // This is the ultimate proof.
    // Start + Duration(Solved) -> EndTicks
    // calculateClipTime(EndTicks) - calculateClipTime(Start) should equal ContentDuration.

    const points = [
      { time: 0, value: 1 },
      { time: 5, value: 5 },
      { time: 10, value: 0.5 },
    ];

    const clip = createClip([
      { type: "speed", parameters: { factor: { type: "spline", points } } },
    ]);

    const startTicks = 1 * TICKS_PER_SECOND;
    const contentDuration = 2.5; // Seconds

    const wallDuration = solveTimelineDuration(
      clip,
      startTicks,
      contentDuration,
    );

    const endTicks = startTicks + wallDuration * TICKS_PER_SECOND;

    const t0 = calculateClipTime(clip, startTicks);
    const t1 = calculateClipTime(clip, endTicks);

    const deltaSeconds = (t1 - t0) / TICKS_PER_SECOND;

    expect(deltaSeconds).toBeCloseTo(contentDuration, 4);
  });

  it("handles stacked speed transforms", () => {
    // Stack: 2x, then 0.5x. Should cancel out to 1x.
    const clip = createClip([
      { type: "speed", parameters: { factor: 2.0 } },
      { type: "speed", parameters: { factor: 0.5 } },
    ]);

    const contentDuration = 1.0;
    const wallDuration = solveTimelineDuration(clip, 0, contentDuration);

    expect(wallDuration).toBeCloseTo(1.0, 4);
  });

  it("handles stacked splines", () => {
    // This validates the pushTimeThroughTransforms logic order.
    // T1 = 2x (Scalar). T2 = Spline(1->2).
    // Pull: Timeline -> T2 -> T1 -> Source.
    // Push: Source -> T1 -> T2 -> Timeline.

    // If we push 1s of Source through T1(2x scalar):
    // T1_out = 1 / 2 = 0.5s "intermediate time".
    // Then T2_out = SolveX_Spline(0.5).
    // Spline is defined in Source Domain?
    // Wait, T2 is "speed transform". Its spline defines speed over ITS INPUT domain?
    // The Spline "Time" axis corresponds to the accumulated time at that point in the chain.
    // Yes.

    const points = [
      { time: 0, value: 1 },
      { time: 10, value: 1 },
    ]; // 1x Spline
    const clip = createClip([
      { type: "speed", parameters: { factor: 2.0 } },
      { type: "speed", parameters: { factor: { type: "spline", points } } },
    ]);

    // Source=10s.
    // T1(2x) -> 5s.
    // T2(1x Spline) -> 5s.
    // Result 5s.

    const wallDuration = solveTimelineDuration(clip, 0, 10.0);
    expect(wallDuration).toBeCloseTo(5.0, 4);
  });
});
