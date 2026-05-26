import { describe, it, expect } from "vitest";
import { Container, Sprite, Texture } from "pixi.js";
import {
  applyTransformStack,
  runApplicators,
} from "../applyTransformations";
import type { ClipTransform } from "../../../types/TimelineTypes";

const LOGICAL = { width: 1920, height: 1080 };

function makeSprite(width = 100, height = 50): Sprite {
  const sprite = new Sprite();
  // Replace the empty texture so getTargetTextureSize sees a real size.
  Object.defineProperty(sprite, "texture", {
    value: { width, height } as unknown as Texture,
    configurable: true,
  });
  return sprite;
}

describe("applyTransformStack", () => {
  it("returns identity state for an empty transformation list with baseLayoutMode 'origin'", () => {
    const { state, sourceTimeTicks } = applyTransformStack(
      [],
      { container: LOGICAL, content: LOGICAL },
      0,
      { baseLayoutMode: "origin", notifyLiveParams: false },
    );

    expect(state.x).toBe(0);
    expect(state.y).toBe(0);
    expect(state.scaleX).toBe(1);
    expect(state.scaleY).toBe(1);
    expect(state.rotation).toBe(0);
    expect(state.filters).toEqual([]);
    expect(sourceTimeTicks).toBe(0);
  });

  it("centers the content under baseLayoutMode 'contain' (clip-style default)", () => {
    const { state } = applyTransformStack(
      [],
      { container: LOGICAL, content: { width: 200, height: 100 } },
      0,
      { baseLayoutMode: "contain", notifyLiveParams: false },
    );

    expect(state.x).toBe(LOGICAL.width / 2);
    expect(state.y).toBe(LOGICAL.height / 2);
  });

  it("dispatches position transforms additively over the base layout", () => {
    const position: ClipTransform = {
      id: "pos-1",
      type: "position",
      isEnabled: true,
      parameters: { x: 10, y: -20 },
    };
    const { state } = applyTransformStack(
      [position],
      { container: LOGICAL, content: LOGICAL },
      0,
      { baseLayoutMode: "origin", notifyLiveParams: false },
    );
    expect(state.x).toBe(10);
    expect(state.y).toBe(-20);
  });

  it("skips speed transforms in the forward pass but applies them in the backward pass", () => {
    // A speed transform shifts the source-time the downstream sample is
    // taken at via the backward pass; the forward pass contributes nothing
    // visual. We just assert the backward pass ran (sourceTimeTicks moved
    // off the input) and the forward layout state is identity.
    const speed: ClipTransform = {
      id: "speed-1",
      type: "speed",
      isEnabled: true,
      parameters: { factor: 2 },
    };
    const { state, sourceTimeTicks } = applyTransformStack(
      [speed],
      { container: LOGICAL, content: LOGICAL },
      1000,
      { baseLayoutMode: "origin", notifyLiveParams: false },
    );
    expect(sourceTimeTicks).not.toBe(1000);
    expect(state.x).toBe(0);
    expect(state.y).toBe(0);
  });

  it("ignores disabled transforms", () => {
    const position: ClipTransform = {
      id: "pos-1",
      type: "position",
      isEnabled: false,
      parameters: { x: 999, y: 999 },
    };
    const { state } = applyTransformStack(
      [position],
      { container: LOGICAL, content: LOGICAL },
      0,
      { baseLayoutMode: "origin", notifyLiveParams: false },
    );
    expect(state.x).toBe(0);
  });
});

describe("runApplicators", () => {
  it("applies layout state to a Sprite target", () => {
    const sprite = makeSprite();
    const { state } = applyTransformStack(
      [
        {
          id: "pos-1",
          type: "position",
          isEnabled: true,
          parameters: { x: 50, y: 75 },
        },
      ],
      { container: LOGICAL, content: { width: 100, height: 50 } },
      0,
      { baseLayoutMode: "origin", notifyLiveParams: false },
    );
    runApplicators(sprite, state, { width: 100, height: 50 });
    expect(sprite.position.x).toBe(50);
    expect(sprite.position.y).toBe(75);
  });

  it("applies layout state to a textureless Container target (group-style)", () => {
    const container = new Container();
    const { state } = applyTransformStack(
      [
        {
          id: "pos-1",
          type: "position",
          isEnabled: true,
          parameters: { x: -10, y: 5 },
        },
      ],
      { container: LOGICAL, content: LOGICAL },
      0,
      { baseLayoutMode: "origin", notifyLiveParams: false },
    );
    runApplicators(container, state, LOGICAL);
    expect(container.position.x).toBe(-10);
    expect(container.position.y).toBe(5);
  });

  it("dispatches a filter transform onto a textureless Container, reading scale from contentSize", () => {
    // A filter transform on a Container must produce a filter instance even
    // though the container has no .texture for the filter applicator to
    // pull a scale from — the explicit contentSize handed to runApplicators
    // provides the fallback. The blur filter uses `worldUniform` scaling on
    // its `strength` parameter; for the smoke check we just verify the
    // applicator produced a filter on the container.
    const container = new Container();
    const blur: ClipTransform = {
      id: "blur-1",
      type: "filter",
      isEnabled: true,
      parameters: { strength: 4, quality: 4 },
      // GenericFilterTransform requires filterName; cast to ClipTransform
      // since the public type doesn't surface that field.
      ...({ filterName: "BlurFilter" } as Record<string, unknown>),
    };
    const { state } = applyTransformStack(
      [blur],
      { container: LOGICAL, content: LOGICAL },
      0,
      { baseLayoutMode: "origin", notifyLiveParams: false },
    );
    expect(state.filters).toHaveLength(1);
    expect(state.filters[0].type).toBe("BlurFilter");

    runApplicators(container, state, LOGICAL);
    expect(container.filters).toBeTruthy();
    const filters = container.filters as unknown as readonly unknown[];
    expect(filters.length).toBe(1);
  });
});
