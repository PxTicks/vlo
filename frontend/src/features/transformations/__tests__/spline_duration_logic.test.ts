import { describe, it, expect } from "vitest";
import { TICKS_PER_SECOND } from "../../timeline";
import {
  solveTimelineDuration,
  getSegmentContentDuration,
} from "../utils/timeCalculation";
import type { TimelineClip } from "../../../types/TimelineTypes";

describe("Spline Duration and Segment Logic", () => {
  const mockClip: TimelineClip = {
    id: "c1",
    trackId: "t1",
    type: "video",
    name: "Test",
    start: 0,
    timelineDuration: 10 * TICKS_PER_SECOND, // 10s Visible
    sourceDuration: 20 * TICKS_PER_SECOND, // 20s Content
    transformedDuration: 10 * TICKS_PER_SECOND,
    transformedOffset: 0,
    croppedSourceDuration: 10 * TICKS_PER_SECOND, // Add croppedSourceDuration
    offset: 0,
    transformations: [],
  };

  // Scenario: Apply Constant Speed 2x via Spline
  // Expected: Duration becomes 5s
  const spline2x = {
    type: "spline",
    points: [
      { time: 0, value: 2 },
      { time: 10 * TICKS_PER_SECOND, value: 2 },
    ],
  };

  // Helper to simulate "Applied Transform" State
  const clipWithSpline2x = {
    ...mockClip,
    transformations: [
      {
        id: "s1",
        type: "speed",
        isEnabled: true,
        parameters: { factor: spline2x },
      },
    ],
  } as TimelineClip;

  describe("solveTimelineDuration (Duration Calculation)", () => {
    it("correctly calculates 5s for 2x Spline Speed", () => {
      const contentSeconds = 10; // 10s source
      const res = solveTimelineDuration(
        clipWithSpline2x,
        mockClip.start,
        contentSeconds,
      );
      expect(res).toBe(5);
    });

    it("correctly calculates ~3.33s for 3x Spline Speed", () => {
      const spline3x = {
        type: "spline",
        points: [
          { time: 0, value: 3 },
          { time: 10 * TICKS_PER_SECOND, value: 3 },
        ],
      };
      const clip3x = {
        ...mockClip,
        transformations: [
          {
            id: "s3",
            type: "speed",
            isEnabled: true,
            parameters: { factor: spline3x },
          },
        ],
      } as TimelineClip;

      const res = solveTimelineDuration(clip3x, mockClip.start, 10);
      expect(res).toBeCloseTo(3.333, 3);
    });
  });

  describe("getSegmentContentDuration (Generalization)", () => {
    it("calculates content duration for simple 2x speed", () => {
      // Speed 2x. Visual 5s -> Content 10s.
      const visualDuration = 5 * TICKS_PER_SECOND;
      const contentTicks = getSegmentContentDuration(
        clipWithSpline2x,
        0,
        visualDuration,
      );

      expect(contentTicks).toBeCloseTo(10 * TICKS_PER_SECOND, -1);
    });

    it("calculates from 'True Start' to 'Cropped Start' (User Request)", () => {
      // Suppose we have a 'transformedOffset' of 2.5s (Visual).
      // With 2x speed, this should correspond to 5.0s (Content).

      const startCropTicks = 2.5 * TICKS_PER_SECOND;
      // The segment is from 0 (clip true start) to 2.5s (visual offset).

      const contentTicks = getSegmentContentDuration(
        clipWithSpline2x,
        0,
        startCropTicks,
      );
      expect(contentTicks).toBeCloseTo(5.0 * TICKS_PER_SECOND, -1);
    });

    it("handles Variable Spline Slope", () => {
      // Ramp 1x -> 3x over 10s. Avg 2x.
      // visual 10s -> content ~20s.
      const splineRamp = {
        type: "spline",
        points: [
          { time: 0, value: 1 },
          { time: 10 * TICKS_PER_SECOND, value: 3 },
        ],
      };
      const clipRamp = {
        ...mockClip,
        transformations: [
          {
            id: "r1",
            type: "speed",
            isEnabled: true,
            parameters: { factor: splineRamp },
          },
        ],
      } as TimelineClip;

      const visualDuration = 10 * TICKS_PER_SECOND;
      const contentTicks = getSegmentContentDuration(
        clipRamp,
        0,
        visualDuration,
      );

      // New Source Domain Logic:
      // Ramp S(t_src) = 1 + 0.2t_src over 10s.
      // Timeline Time required to play 10s Source = Integral(1 / (1+0.2t)) dt from 0 to 10.
      // = 5 * ln(3) ~= 5.493s.
      // We play for 10s Timeline total. Remaining Timeline = 10 - 5.493 = 4.507s.
      // Extrapolating at Speed 3: Content = 4.507 * 3 = 13.521s.
      // Total Content = 10 + 13.521 = 23.521s.
      expect(contentTicks / TICKS_PER_SECOND).toBeCloseTo(23.5, 1);
    });
  });

  describe("Inverse Calculation (Content -> Timeline) using solveTimelineDuration", () => {
    it("calculates proper transformedOffset given an Offset (Content)", () => {
      // User wants to ensure we can go from "Offset" (Content) -> "transformedOffset" (Timeline).
      // Given Offset = 5s (Content). Speed 2x.
      // define 'startTicks' = 0 (relative to uncropped).
      // Expected Visual Duration = 2.5s.

      const targetContent = 5.0; // Seconds

      const timelineDuration = solveTimelineDuration(
        clipWithSpline2x,
        0,
        targetContent,
      );

      expect(timelineDuration).toBeCloseTo(2.5, 3);
    });
  });

  describe("Interaction with Resize Logic", () => {
    // Simulating the logic in useClipResize
    it("calculates correct Offset Delta when extending Left with Spline", () => {
      // Start State:
      // Clip has transformedOffset = 2.5s (Visual)
      // Offset = 5s (Content)
      // Speed = 2x
      const clipState = {
        ...clipWithSpline2x,
        transformedOffset: 2.5 * TICKS_PER_SECOND,
        offset: 5 * TICKS_PER_SECOND,
      };

      // User drags Left by -1s (Visual extension).
      // validDelta = -1s * TICKS.
      const validDelta = -1 * TICKS_PER_SECOND;

      // Check calculateSourceDelta
      const offsetDelta = getSegmentContentDuration(clipState, 0, validDelta);

      // Expected: -1s visual * 2x Speed = -2s Content change.
      expect(offsetDelta / TICKS_PER_SECOND).toBeCloseTo(-2.0, 3);

      // New Offset should be 5s - 2s = 3s.
      expect((clipState.offset + offsetDelta) / TICKS_PER_SECOND).toBeCloseTo(
        3.0,
        3,
      );
    });
  });
});
