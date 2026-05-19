import { describe, expect, it } from "vitest";
import { reverseTransformationStack } from "../reverseTransformations";
import type { ClipTransform } from "../../../../types/TimelineTypes";
import type {
  PositionTransform,
  ScaleTransform,
  SpeedTransform,
} from "../../types";

const SOURCE_DURATION = 96000 * 10; // 10s at 96kHz tick rate

function basePosition(): PositionTransform {
  return {
    id: "pos",
    type: "position",
    isEnabled: true,
    parameters: {
      x: {
        type: "spline",
        points: [
          { time: 0, value: 0 },
          { time: SOURCE_DURATION, value: 200 },
        ],
      },
      y: 0,
    },
    keyframeTimes: [0, SOURCE_DURATION],
  };
}

function baseScale(): ScaleTransform {
  return {
    id: "scale",
    type: "scale",
    isEnabled: true,
    parameters: {
      x: 1,
      y: 1,
    },
  };
}

function baseSpeed(): SpeedTransform {
  return {
    id: "speed",
    type: "speed",
    isEnabled: true,
    parameters: {
      factor: {
        type: "spline",
        points: [
          { time: 0, value: 1 },
          { time: SOURCE_DURATION, value: 1 },
        ],
      },
    },
    keyframeTimes: [0, SOURCE_DURATION],
  };
}

describe("reverseTransformationStack", () => {
  it("returns [] for empty input", () => {
    expect(reverseTransformationStack([], SOURCE_DURATION)).toEqual([]);
  });

  it("mirrors a scalar spline around layer midpoint when there are no upstream speeds", () => {
    const stack: ClipTransform[] = [basePosition()];
    const reversed = reverseTransformationStack(stack, SOURCE_DURATION);

    const reversedX = (reversed[0].parameters as PositionTransform["parameters"]).x;
    expect(reversedX).toMatchObject({
      type: "spline",
      points: [
        { time: 0, value: 200 },
        { time: SOURCE_DURATION, value: 0 },
      ],
    });
    expect(reversed[0].keyframeTimes).toEqual([0, SOURCE_DURATION]);
  });

  it("is involutive (double reversal returns to the original)", () => {
    const stack: ClipTransform[] = [basePosition(), baseScale(), baseSpeed()];
    const once = reverseTransformationStack(stack, SOURCE_DURATION);
    const twice = reverseTransformationStack(once, SOURCE_DURATION);

    expect(twice).toEqual(stack);
  });

  it("mirrors a uniform-speed spline (no-op preserved values)", () => {
    const reversed = reverseTransformationStack(
      [baseSpeed()],
      SOURCE_DURATION,
    );
    const factor = (reversed[0].parameters as SpeedTransform["parameters"])
      .factor;
    expect(factor).toMatchObject({
      type: "spline",
      points: [
        { time: 0, value: 1 },
        { time: SOURCE_DURATION, value: 1 },
      ],
    });
  });

  it("reverses position-path timing without altering the geometry", () => {
    const pos: PositionTransform = {
      id: "pos-path",
      type: "position",
      isEnabled: true,
      parameters: {
        x: 0,
        y: 0,
        path: {
          type: "path2d",
          curve: "centripetal_catmull_rom",
          controlPoints: [
            { x: 0, y: 0 },
            { x: 50, y: 100 },
            { x: 200, y: 50 },
          ],
          timing: {
            type: "spline",
            points: [
              { time: 0, value: 0 },
              { time: 0.5, value: 0.2 },
              { time: 1, value: 1 },
            ],
          },
        },
      },
    };

    const [reversed] = reverseTransformationStack([pos], SOURCE_DURATION);
    const reversedPos = reversed as PositionTransform;
    expect(reversedPos.parameters.path?.controlPoints).toEqual(
      pos.parameters.path!.controlPoints,
    );
    expect(reversedPos.parameters.path?.timing.points).toEqual([
      { time: 0, value: 0 },
      { time: 0.5, value: 0.8 },
      { time: 1, value: 1 },
    ]);
  });

  it("preserves non-spline scalar parameters", () => {
    const stack: ClipTransform[] = [baseScale()];
    const reversed = reverseTransformationStack(stack, SOURCE_DURATION);
    const scale = reversed[0] as ScaleTransform;
    expect(scale.parameters.x).toBe(1);
    expect(scale.parameters.y).toBe(1);
  });
});
