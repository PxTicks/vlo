import { describe, expect, it } from "vitest";
import {
  createClipCurveEvaluators,
  getConstantVolumeGain,
} from "../TrackAudioRenderer";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { ScalarParameter } from "../../../transformations";

function clipWithTransforms(
  transformations: Array<{
    type: string;
    isEnabled: boolean;
    parameters: Record<string, unknown>;
  }>,
): TimelineClip {
  return { transformations } as unknown as TimelineClip;
}

function volumeClip(gain: ScalarParameter, isEnabled = true): TimelineClip {
  return clipWithTransforms([
    { type: "volume", isEnabled, parameters: { gain } },
  ]);
}

function splineGain(
  points: Array<{ time: number; value: number }>,
): ScalarParameter {
  return { type: "spline", points } as ScalarParameter;
}

describe("getConstantVolumeGain", () => {
  it("defaults to unity gain when there is no enabled volume transform", () => {
    expect(getConstantVolumeGain(clipWithTransforms([]))).toBe(1);
    expect(getConstantVolumeGain({} as TimelineClip)).toBe(1);
    expect(getConstantVolumeGain(volumeClip(0.5, false))).toBe(1);
  });

  it("returns the numeric gain of an enabled volume transform", () => {
    expect(getConstantVolumeGain(volumeClip(0.75))).toBe(0.75);
    expect(getConstantVolumeGain(volumeClip(0))).toBe(0);
  });

  it("returns null when the gain is keyframed (a spline)", () => {
    expect(
      getConstantVolumeGain(
        volumeClip(splineGain([{ time: 0, value: 1 }])),
      ),
    ).toBeNull();
  });
});

describe("createClipCurveEvaluators", () => {
  it("uses a constant gain when the volume is not keyframed", () => {
    const evaluators = createClipCurveEvaluators(volumeClip(0.5));
    expect(evaluators.constantVolumeGain).toBe(0.5);
    expect(evaluators.evaluateVolume(0)).toBe(0.5);
    expect(evaluators.evaluateVolume(9999)).toBe(0.5);
  });

  it("clamps negative constant gains to zero", () => {
    const evaluators = createClipCurveEvaluators(volumeClip(-0.3));
    expect(evaluators.constantVolumeGain).toBe(-0.3);
    expect(evaluators.evaluateVolume(0)).toBe(0);
  });

  it("treats a clip without volume transforms as unity gain", () => {
    const evaluators = createClipCurveEvaluators(clipWithTransforms([]));
    expect(evaluators.constantVolumeGain).toBe(1);
    expect(evaluators.evaluateVolume(123)).toBe(1);
  });

  it("evaluates a keyframed gain spline over time", () => {
    const evaluators = createClipCurveEvaluators(
      volumeClip(
        splineGain([
          { time: 0, value: 0 },
          { time: 100, value: 1 },
        ]),
      ),
    );
    expect(evaluators.constantVolumeGain).toBeNull();
    expect(evaluators.evaluateVolume(0)).toBeCloseTo(0, 5);
    expect(evaluators.evaluateVolume(100)).toBeCloseTo(1, 5);
  });

  it("clamps a keyframed gain that dips below zero", () => {
    const evaluators = createClipCurveEvaluators(
      volumeClip(
        splineGain([
          { time: 0, value: -1 },
          { time: 100, value: -1 },
        ]),
      ),
    );
    expect(evaluators.evaluateVolume(50)).toBe(0);
  });
});
