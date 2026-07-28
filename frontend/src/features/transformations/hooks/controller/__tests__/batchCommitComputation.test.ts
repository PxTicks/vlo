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
  it("keeps explicit scale axes authoritative when dimensions are linked", () => {
    const transform = createAddTransform("scale");
    expect(transform).not.toBeNull();
    if (!transform) return;
    const clip = createClip([transform]);

    const next = computeBatchCommitMutations({
      groupId: "scale",
      values: { x: -2, y: 2 },
      transformId: transform.id,
      transforms: [transform],
      activeClip: clip,
      playheadTicks: 0,
      pointEpsilonTicks: 1,
    });

    expect(next[0].parameters).toMatchObject({
      x: -2,
      y: 2,
      isLinked: true,
    });
  });

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

  it("uses owning control metadata for scalar commits from the grade extension zone", () => {
    const transform = createAddTransform("ColorGradeFilter", true);
    expect(transform).not.toBeNull();
    if (!transform) return;
    transform.parameters.exposure = {
      type: "spline",
      points: [
        { time: 0, value: 0 },
        { time: 100, value: 1 },
      ],
    };
    transform.keyframeTimes = [0, 100];
    const clip = createClip([transform]);

    const next = computeBatchCommitMutations({
      groupId: "color_grade_extensions",
      values: { exposure: 0.75 },
      transformId: transform.id,
      transforms: [transform],
      activeClip: clip,
      playheadTicks: 50,
      pointEpsilonTicks: 1,
      keyframeSourceTimeTicks: 50,
    });

    expect(next[0].keyframeTimes).toEqual([0, 50, 100]);
    expect(isSplineParameter(next[0].parameters.exposure)).toBe(true);
    if (!isSplineParameter(next[0].parameters.exposure)) return;
    expect(
      next[0].parameters.exposure.points.find((point) => point.time === 50)?.value,
    ).toBe(0.75);
  });

  it("updates keyframe bookkeeping for spline commits from the grade extension zone", () => {
    const transform = createAddTransform("ColorGradeFilter", true);
    expect(transform).not.toBeNull();
    if (!transform) return;
    transform.parameters.exposure = {
      type: "spline",
      points: [
        { time: 0, value: 0 },
        { time: 100, value: 1 },
      ],
    };
    transform.keyframeTimes = [0, 100];

    const next = computeBatchCommitMutations({
      groupId: "color_grade_extensions",
      values: {
        exposure: {
          type: "spline",
          points: [
            { time: 0, value: 0 },
            { time: 40, value: 0.5 },
            { time: 100, value: 1 },
          ],
        },
      },
      transformId: transform.id,
      transforms: [transform],
      playheadTicks: 40,
      pointEpsilonTicks: 1,
    });

    expect(next[0].keyframeTimes).toEqual([0, 40, 100]);
  });
});
