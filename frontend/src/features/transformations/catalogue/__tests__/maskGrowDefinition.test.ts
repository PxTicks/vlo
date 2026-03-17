import { describe, it, expect } from "vitest";
import type { ClipTransform } from "../../../../types/TimelineTypes";
import type { TransformState } from "../types";
import { maskGrowDefinition } from "../mask/grow";

function createBaseState(): TransformState {
  return {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    filters: [],
  };
}

function createTransform(parameters: Record<string, unknown>): ClipTransform {
  return {
    id: "mask_grow_1",
    type: "mask_grow",
    isEnabled: true,
    parameters,
  };
}

const context = {
  container: { width: 1920, height: 1080 },
  content: { width: 1920, height: 1080 },
  time: 0,
};

describe("maskGrowDefinition handler", () => {
  it("reads scalar amount", () => {
    const state = createBaseState();
    const transform = createTransform({ amount: 12 });

    maskGrowDefinition.handler(state, transform, context);

    expect(state.maskGrow).toEqual({ amount: 12 });
  });

  it("resolves spline amount at current time", () => {
    const state = createBaseState();
    const transform = createTransform({
      amount: {
        type: "spline",
        points: [
          { time: 0, value: 0 },
          { time: 10, value: 20 },
        ],
      },
    });

    maskGrowDefinition.handler(state, transform, { ...context, time: 5 });

    expect(state.maskGrow?.amount).toBeCloseTo(10);
  });
});
