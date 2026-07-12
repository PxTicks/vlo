import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../../../types/TimelineTypes";
import { isSplineParameter } from "../../../types";
import { createAddTransform } from "../transformFactory";
import { computeBatchCommitMutations } from "../batchCommitComputation";

function createClip(transformations: TimelineClip["transformations"]): TimelineClip {
  return {
    id: "clip-grade",
    trackId: "track-1",
    start: 0,
    timelineDuration: 100,
    offset: 0,
    type: "video",
    croppedSourceDuration: 100,
    name: "Grade clip",
    assetId: "asset-grade",
    sourceDuration: 100,
    transformedDuration: 100,
    transformedOffset: 0,
    transformations,
  };
}

describe("computeBatchCommitMutations", () => {
  it("atomically preserves and extends wheel scalar splines", () => {
    const transform = createAddTransform("ColorGradeFilter", true);
    expect(transform).not.toBeNull();
    if (!transform) return;
    transform.keyframeTimes = [0, 100];
    const clip = createClip([transform]);

    const next = computeBatchCommitMutations({
      groupId: "color_grade_wheels",
      values: { liftR: 0.1, liftG: -0.05, liftB: 0.03 },
      transformId: transform.id,
      transforms: [transform],
      activeClip: clip,
      playheadTicks: 50,
      pointEpsilonTicks: 1,
      keyframeSourceTimeTicks: 50,
    });

    expect(next).toHaveLength(1);
    expect(next[0].keyframeTimes).toEqual([0, 50, 100]);
    for (const name of ["liftR", "liftG", "liftB"]) {
      expect(isSplineParameter(next[0].parameters[name])).toBe(true);
    }
    expect(next[0].parameters.liftMaster).toBe(0);
  });

  it("rebuilds grade keyframe bookkeeping when replacing grade parameters", () => {
    const transform = createAddTransform("ColorGradeFilter", true);
    expect(transform).not.toBeNull();
    if (!transform) return;
    transform.parameters.exposure = {
      type: "spline",
      points: [{ time: 25, value: 1 }],
    };
    transform.parameters.saturation = {
      type: "spline",
      points: [{ time: 75, value: 0.8 }],
    };
    transform.keyframeTimes = [25, 75, 90];

    const next = computeBatchCommitMutations({
      groupId: "color_grade_management",
      values: {
        exposure: 0,
        contrast: {
          type: "spline",
          points: [
            { time: 10, value: 1 },
            { time: 60, value: 1.2 },
          ],
        },
      },
      transformId: transform.id,
      transforms: [transform],
      playheadTicks: 50,
      pointEpsilonTicks: 1,
    });

    expect(next[0].parameters.exposure).toBe(0);
    expect(next[0].keyframeTimes).toEqual([10, 60, 75]);
  });
});
