import { describe, expect, it } from "vitest";
import { Container, AlphaFilter, BlurFilter } from "pixi.js";
import type { ClipTransform, TimelineGroup } from "../../../types/TimelineTypes";
import { applyGroupTransforms } from "../applyGroupTransforms";

function group(overrides: Partial<TimelineGroup> & Pick<TimelineGroup, "id">): TimelineGroup {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    trackIds: overrides.trackIds ?? [],
    start: overrides.start ?? 0,
    timelineDuration: overrides.timelineDuration ?? 100,
    transformations: overrides.transformations ?? [],
    isVisible: overrides.isVisible ?? true,
  };
}

const LOGICAL = { width: 1920, height: 1080 };

describe("applyGroupTransforms — identity path", () => {
  it("resets a clean container to identity when transformations is empty", () => {
    const container = new Container();
    applyGroupTransforms(container, group({ id: "g1" }), LOGICAL, 0);
    expect(container.position.x).toBe(0);
    expect(container.position.y).toBe(0);
    expect(container.scale.x).toBe(1);
    expect(container.scale.y).toBe(1);
    expect(container.rotation).toBe(0);
    expect(container.filters).toBeNull();
  });

  it("reverts a previously-transformed container to identity when transformations is empty", () => {
    const container = new Container();
    container.position.set(50, 75);
    container.scale.set(2, 3);
    container.rotation = 0.5;
    container.filters = [new AlphaFilter()];

    applyGroupTransforms(container, group({ id: "g1" }), LOGICAL, 0);

    expect(container.position.x).toBe(0);
    expect(container.position.y).toBe(0);
    expect(container.scale.x).toBe(1);
    expect(container.scale.y).toBe(1);
    expect(container.rotation).toBe(0);
    expect(container.filters).toBeNull();
  });

  it("is safe at any tick (active or inactive window)", () => {
    const container = new Container();
    expect(() =>
      applyGroupTransforms(
        container,
        group({ id: "g1", start: 100, timelineDuration: 50 }),
        LOGICAL,
        50, // before window
      ),
    ).not.toThrow();
    expect(() =>
      applyGroupTransforms(
        container,
        group({ id: "g1", start: 100, timelineDuration: 50 }),
        LOGICAL,
        125, // inside window
      ),
    ).not.toThrow();
    expect(container.position.x).toBe(0);
  });
});

describe("applyGroupTransforms — real dispatch", () => {
  it("dispatches a position transform onto the container", () => {
    const container = new Container();
    const position: ClipTransform = {
      id: "pos-1",
      type: "position",
      isEnabled: true,
      parameters: { x: 42, y: -17 },
    };
    applyGroupTransforms(
      container,
      group({ id: "g1", transformations: [position] }),
      LOGICAL,
      0,
    );
    expect(container.position.x).toBe(42);
    expect(container.position.y).toBe(-17);
  });

  it("dispatches a scale transform onto the container", () => {
    const container = new Container();
    // The scale handler multiplies state.scaleX by params.x (and same for y),
    // starting from the origin-mode default of 1. The scale params are
    // named x/y to match the position handler's shape.
    const scale: ClipTransform = {
      id: "scale-1",
      type: "scale",
      isEnabled: true,
      parameters: { x: 2, y: 0.5 },
    };
    applyGroupTransforms(
      container,
      group({ id: "g1", transformations: [scale] }),
      LOGICAL,
      0,
    );
    expect(container.scale.x).toBe(2);
    expect(container.scale.y).toBe(0.5);
  });

  it("dispatches a filter transform onto a textureless container", () => {
    const container = new Container();
    const blur: ClipTransform = {
      id: "blur-1",
      type: "filter",
      isEnabled: true,
      parameters: { strength: 4, quality: 4 },
      ...({ filterName: "BlurFilter" } as Record<string, unknown>),
    };
    applyGroupTransforms(
      container,
      group({ id: "g1", transformations: [blur] }),
      LOGICAL,
      0,
    );
    const filters = container.filters as readonly unknown[] | null;
    expect(Array.isArray(filters)).toBe(true);
    expect(filters!.length).toBe(1);
    expect(filters![0]).toBeInstanceOf(BlurFilter);
  });

  it("samples keyframe time clip-locally (currentTick - group.start)", () => {
    // Use a position transform whose value tracks an x-only ramp via
    // SplineParameter would be overkill; we just confirm that calling
    // applyGroupTransforms at currentTick=110 with group.start=100 is
    // equivalent to calling it at currentTick=10 with group.start=0.
    const position: ClipTransform = {
      id: "pos-1",
      type: "position",
      isEnabled: true,
      parameters: { x: 10, y: 20 },
    };

    const containerA = new Container();
    applyGroupTransforms(
      containerA,
      group({ id: "ga", start: 100, timelineDuration: 50, transformations: [position] }),
      LOGICAL,
      110,
    );

    const containerB = new Container();
    applyGroupTransforms(
      containerB,
      group({ id: "gb", start: 0, timelineDuration: 50, transformations: [position] }),
      LOGICAL,
      10,
    );

    expect(containerA.position.x).toBe(containerB.position.x);
    expect(containerA.position.y).toBe(containerB.position.y);
  });

  it("reverts to identity when transformations becomes empty after a prior dispatch", () => {
    const container = new Container();
    const position: ClipTransform = {
      id: "pos-1",
      type: "position",
      isEnabled: true,
      parameters: { x: 100, y: 100 },
    };
    // First call: applies a position.
    applyGroupTransforms(
      container,
      group({ id: "g1", transformations: [position] }),
      LOGICAL,
      0,
    );
    expect(container.position.x).toBe(100);

    // Second call: transformations now empty. Container should be back to
    // identity rather than retaining the prior frame's state.
    applyGroupTransforms(container, group({ id: "g1" }), LOGICAL, 0);
    expect(container.position.x).toBe(0);
    expect(container.position.y).toBe(0);
    expect(container.filters).toBeNull();
  });

  it("skips disabled transforms in the dispatch", () => {
    const container = new Container();
    const position: ClipTransform = {
      id: "pos-1",
      type: "position",
      isEnabled: false,
      parameters: { x: 999, y: 999 },
    };
    applyGroupTransforms(
      container,
      group({ id: "g1", transformations: [position] }),
      LOGICAL,
      0,
    );
    expect(container.position.x).toBe(0);
    expect(container.position.y).toBe(0);
  });
});
