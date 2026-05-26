import { describe, expect, it } from "vitest";
import { Container, AlphaFilter } from "pixi.js";
import type { TimelineGroup } from "../../../types/TimelineTypes";
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

describe("applyGroupTransforms — identity-only seam (v1)", () => {
  it("resets a clean container to identity (no-op)", () => {
    const container = new Container();
    applyGroupTransforms(container, group({ id: "g1" }), LOGICAL, 0);
    expect(container.position.x).toBe(0);
    expect(container.position.y).toBe(0);
    expect(container.scale.x).toBe(1);
    expect(container.scale.y).toBe(1);
    expect(container.rotation).toBe(0);
    expect(container.filters).toBeNull();
  });

  it("resets a previously-transformed container back to identity", () => {
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

  it("is safe with empty transformations and at any tick (active or inactive)", () => {
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
