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
});
