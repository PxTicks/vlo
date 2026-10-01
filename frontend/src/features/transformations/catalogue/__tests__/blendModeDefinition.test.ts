import { describe, it, expect } from "vitest";
import { AlphaFilter } from "pixi.js";
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
import { filterApplicator } from "../filterFactory";

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

describe("blendModeApplicator on a filtered target", () => {
  function createFilteredTarget(filters: AlphaFilter[]) {
    return { ...createTarget(), filters };
  }

  it("moves a standard mode onto the last filter and draws the target normally", () => {
    const [first, last] = [new AlphaFilter(), new AlphaFilter()];
    const target = createFilteredTarget([first, last]);
    const state = createBaseState();
    state.blendMode = "multiply";

    blendModeApplicator(target, state);

    expect(target.blendMode).toBe("normal");
    expect(first.blendMode).toBe("normal");
    expect(last.blendMode).toBe("multiply");
  });

  it("restores a filter's own mode once it is no longer last or the mode resets", () => {
    const [first, last] = [new AlphaFilter(), new AlphaFilter()];
    first.blendMode = "none";
    const state = createBaseState();
    state.blendMode = "screen";

    blendModeApplicator(createFilteredTarget([first]), state);
    expect(first.blendMode).toBe("screen");

    blendModeApplicator(createFilteredTarget([first, last]), state);
    expect(first.blendMode).toBe("none");
    expect(last.blendMode).toBe("screen");

    const target = createFilteredTarget([first, last]);
    blendModeApplicator(target, createBaseState());
    expect(last.blendMode).toBe("normal");
    expect(target.blendMode).toBe("normal");
  });

  it("keeps an advanced mode on the target, which filters cannot carry", () => {
    const filter = new AlphaFilter();
    const target = createFilteredTarget([filter]);
    const state = createBaseState();
    state.blendMode = "overlay";

    blendModeApplicator(target, state);

    expect(target.blendMode).toBe("overlay");
    expect(filter.blendMode).toBe("normal");
  });
});

describe("blend mode registration", () => {
  it("is an always-visible default for visual clips", () => {
    const types = getDefaultTransforms().map((d) => d.type);
    expect(types).toContain("blendMode");
  });

  it("registers the applicator after the filter applicator", () => {
    const { applicators } = TransformationSystem;
    expect(applicators.indexOf(blendModeApplicator)).toBeGreaterThan(
      applicators.indexOf(filterApplicator),
    );
  });

  it("exposes Normal as the first option and default", () => {
    expect(BLEND_MODE_OPTIONS[0].value).toBe(DEFAULT_BLEND_MODE);
  });
});
