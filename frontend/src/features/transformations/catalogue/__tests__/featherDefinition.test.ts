import { describe, it, expect } from "vitest";
import type { ClipTransform } from "../../../../types/TimelineTypes";
import type { TransformState } from "../types";
import { featherDefinition } from "../mask/feather";

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
    id: "feather_1",
    type: "feather",
    isEnabled: true,
    parameters,
  };
}

const context = {
  container: { width: 1920, height: 1080 },
  content: { width: 1920, height: 1080 },
  time: 0,
};

describe("featherDefinition handler", () => {
  it("defaults to hard outer mode when mode is missing", () => {
    const state = createBaseState();
    const transform = createTransform({ amount: 12 });

    featherDefinition.handler(state, transform, context);

    expect(state.feather).toEqual({
      amount: 12,
      mode: "hard_outer",
    });
  });

  it("accepts explicit soft inner mode", () => {
    const state = createBaseState();
    const transform = createTransform({ amount: 8, mode: "soft_inner" });

    featherDefinition.handler(state, transform, context);

    expect(state.feather?.mode).toBe("soft_inner");
  });

  it("accepts explicit hard outer mode", () => {
    const state = createBaseState();
    const transform = createTransform({ amount: 8, mode: "hard_outer" });

    featherDefinition.handler(state, transform, context);

    expect(state.feather?.mode).toBe("hard_outer");
  });

  it("accepts explicit two-way mode", () => {
    const state = createBaseState();
    const transform = createTransform({ amount: 8, mode: "two_way" });

    featherDefinition.handler(state, transform, context);

    expect(state.feather?.mode).toBe("two_way");
  });

  it("falls back to hard outer for unknown mode values", () => {
    const state = createBaseState();
    const transform = createTransform({ amount: 8, mode: "bogus_mode" });

    featherDefinition.handler(state, transform, context);

    expect(state.feather?.mode).toBe("hard_outer");
  });
});
