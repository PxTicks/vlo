import { describe, it, expect } from "vitest";
import type { ClipTransform } from "../../../../types/TimelineTypes";
import type { ClipTransformTarget, TransformState } from "../types";
import {
  BLEND_MODE_OPTIONS,
  DEFAULT_BLEND_MODE,
  blendModeApplicator,
  blendModeDefinition,
} from "../blendMode";
import {
  TransformationSystem,
  getDefaultTransforms,
} from "../TransformationRegistry";

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
    id: "blend_1",
    type: "blendMode",
    isEnabled: true,
    parameters,
  };
}

function createTarget(): ClipTransformTarget & { blendMode: string } {
  return {
    position: { x: 0, y: 0, set: () => {} },
    scale: { x: 1, y: 1, set: () => {} },
    rotation: 0,
    blendMode: "normal",
  };
}

const context = {
  container: { width: 1920, height: 1080 },
  content: { width: 1920, height: 1080 },
  time: 0,
};

describe("blendModeDefinition handler", () => {
  it("writes the selected blend mode onto state", () => {
    const state = createBaseState();
    blendModeDefinition.handler(state, createTransform({ blendMode: "multiply" }), context);
    expect(state.blendMode).toBe("multiply");
  });

  it("ignores a non-string blend mode value", () => {
    const state = createBaseState();
    blendModeDefinition.handler(state, createTransform({ blendMode: 5 }), context);
    expect(state.blendMode).toBeUndefined();
  });
});

describe("blendModeApplicator", () => {
  it("applies the resolved blend mode to the target", () => {
    const target = createTarget();
    const state = createBaseState();
    state.blendMode = "screen";
    blendModeApplicator(target, state);
    expect(target.blendMode).toBe("screen");
  });

  it("defaults to normal when no blend mode is set (restores reused sprites)", () => {
    const target = createTarget();
    target.blendMode = "overlay";
    blendModeApplicator(target, createBaseState());
    expect(target.blendMode).toBe(DEFAULT_BLEND_MODE);
  });
});

describe("blend mode registration", () => {
  it("is an always-visible default for visual clips", () => {
    const types = getDefaultTransforms().map((d) => d.type);
    expect(types).toContain("blendMode");
  });

  it("registers the applicator in the runtime system", () => {
    expect(TransformationSystem.applicators).toContain(blendModeApplicator);
  });

  it("exposes Normal as the first option and default", () => {
    expect(BLEND_MODE_OPTIONS[0].value).toBe(DEFAULT_BLEND_MODE);
  });
});
