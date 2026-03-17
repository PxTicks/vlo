import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../../timeline";
import { isSplineParameter } from "../../../types";
import { computeCommitMutation } from "../commitComputation";

function createClip(transformations: TimelineClip["transformations"]): TimelineClip {
  return {
    id: "clip-1",
    trackId: "track-1",
    start: 0,
    timelineDuration: 10 * TICKS_PER_SECOND,
    offset: 0,
    type: "video",
    croppedSourceDuration: 10 * TICKS_PER_SECOND,
    name: "Test Clip",
    sourceDuration: 10 * TICKS_PER_SECOND,
    transformedDuration: 10 * TICKS_PER_SECOND,
    transformedOffset: 0,
    transformations,
  };
}

describe("computeCommitMutation", () => {
  it("adds a keyframe time and materializes scalar values in a primed spline group", () => {
    const transform = {
      id: "position-1",
      type: "position",
      isEnabled: true,
      parameters: { x: 0, y: 0 },
      keyframeTimes: [120, 880],
    };
    const clip = createClip([transform]);

    const result = computeCommitMutation({
      groupId: "position",
      controlName: "x",
      value: 50,
      transformId: transform.id,
      transforms: clip.transformations,
      activeClip: clip,
      playheadTicks: 500,
      pointEpsilonTicks: 1,
    });

    expect(result.mode).toBe("update");
    if (result.mode !== "update") return;

    expect(result.keyframeTimes).toEqual([120, 500, 880]);
    expect(isSplineParameter(result.parameters.x)).toBe(true);
    const points = (result.parameters.x as { points: Array<{ time: number; value: number }> })
      .points;
    expect(points.map((point) => point.time)).toEqual([120, 500, 880]);
    expect(points.find((point) => point.time === 500)?.value).toBe(50);
  });

  it("commits numeric edits into an in-place spline even when keyframeTimes were missing", () => {
    const transform = {
      id: "position-legacy-spline",
      type: "position",
      isEnabled: true,
      parameters: {
        x: {
          type: "spline" as const,
          points: [
            { time: 120, value: 0 },
            { time: 880, value: 10 },
          ],
        },
        y: 0,
      },
    };
    const clip = createClip([transform]);

    const result = computeCommitMutation({
      groupId: "position",
      controlName: "x",
      value: 50,
      transformId: transform.id,
      transforms: clip.transformations,
      activeClip: clip,
      playheadTicks: 500,
      pointEpsilonTicks: 1,
    });

    expect(result.mode).toBe("update");
    if (result.mode !== "update") return;

    expect(result.keyframeTimes).toEqual([500]);
    expect(isSplineParameter(result.parameters.x)).toBe(true);
    const xPoints = (result.parameters.x as { points: Array<{ time: number; value: number }> })
      .points;
    expect(xPoints.map((point) => point.time)).toEqual([120, 500, 880]);
    expect(xPoints.find((point) => point.time === 500)?.value).toBe(50);
  });

  it("reconciles spline endpoint keyframe times without fan-out to sibling controls", () => {
    const transform = {
      id: "position-2",
      type: "position",
      isEnabled: true,
      parameters: {
        x: {
          type: "spline" as const,
          points: [
            { time: 120, value: 0 },
            { time: 880, value: 10 },
          ],
        },
        y: {
          type: "spline" as const,
          points: [
            { time: 120, value: 0 },
            { time: 880, value: 20 },
          ],
        },
      },
      keyframeTimes: [120, 880],
    };
    const clip = createClip([transform]);

    const result = computeCommitMutation({
      groupId: "position",
      controlName: "x",
      value: {
        type: "spline",
        points: [
          { time: 120, value: 0 },
          { time: 500, value: 5 },
          { time: 880, value: 10 },
        ],
      },
      transformId: transform.id,
      transforms: clip.transformations,
      activeClip: clip,
      playheadTicks: 500,
      pointEpsilonTicks: 1,
    });

    expect(result.mode).toBe("update");
    if (result.mode !== "update") return;

    expect(result.keyframeTimes).toEqual([120, 500, 880]);
    const yParam = result.parameters.y as {
      type: "spline";
      points: Array<{ time: number; value: number }>;
    };
    expect(yParam.points.map((point) => point.time)).toEqual([120, 880]);
  });

  it("updates linked paired controls when isLinked is true", () => {
    const transform = {
      id: "scale-1",
      type: "scale",
      isEnabled: true,
      parameters: { x: 1, y: 2, isLinked: true },
    };

    const result = computeCommitMutation({
      groupId: "scale",
      controlName: "x",
      value: 3,
      transformId: transform.id,
      transforms: [transform],
      activeClip: createClip([transform]),
      playheadTicks: 0,
      pointEpsilonTicks: 1,
    });

    expect(result.mode).toBe("update");
    if (result.mode !== "update") return;

    expect(result.parameters.x).toBe(3);
    expect(result.parameters.y).toBe(6);
  });

  it("materializes linked sibling controls during keyframed numeric commits", () => {
    const transform = {
      id: "scale-keyframed-link",
      type: "scale",
      isEnabled: true,
      parameters: { x: 1, y: 1, isLinked: true },
      keyframeTimes: [0, 100],
    };
    const clip = createClip([transform]);

    const result = computeCommitMutation({
      groupId: "scale",
      controlName: "x",
      value: 2,
      transformId: transform.id,
      transforms: clip.transformations,
      activeClip: clip,
      playheadTicks: 50,
      pointEpsilonTicks: 1,
    });

    expect(result.mode).toBe("update");
    if (result.mode !== "update") return;

    expect(result.keyframeTimes).toEqual([0, 50, 100]);
    expect(isSplineParameter(result.parameters.x)).toBe(true);
    expect(isSplineParameter(result.parameters.y)).toBe(true);

    const xPoints = (result.parameters.x as { points: Array<{ time: number; value: number }> })
      .points;
    const yPoints = (result.parameters.y as { points: Array<{ time: number; value: number }> })
      .points;

    expect(xPoints.map((point) => point.time)).toEqual([0, 50, 100]);
    expect(yPoints.map((point) => point.time)).toEqual([0, 50, 100]);
    expect(xPoints.find((point) => point.time === 50)?.value).toBe(2);
    expect(yPoints.find((point) => point.time === 50)?.value).toBe(2);
  });
});
