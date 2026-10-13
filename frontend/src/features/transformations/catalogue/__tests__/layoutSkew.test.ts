import { describe, expect, it } from "vitest";
import { Container } from "pixi.js";
import type { ClipTransform } from "../../../../types/TimelineTypes";
import { applyTransformStack, runApplicators } from "../../applyTransformations";

const CONTAINER = { width: 1920, height: 1080 };

function renderLayout(transformations: ClipTransform[]) {
  const target = new Container();
  const { state } = applyTransformStack(
    transformations,
    { container: CONTAINER, content: CONTAINER },
    0,
    { baseLayoutMode: "origin", notifyLiveParams: false },
  );
  runApplicators(target, state, CONTAINER);
  target.updateLocalTransform();
  return { state, matrix: target.localTransform };
}

describe("layout skew", () => {
  it("accumulates skew parameters into the layout state", () => {
    const { state } = renderLayout([
      {
        id: "skew_1",
        type: "skew",
        isEnabled: true,
        parameters: { x: 0.2, y: -0.1 },
      },
    ]);
    expect(state.skewX).toBeCloseTo(0.2);
    expect(state.skewY).toBeCloseTo(-0.1);
  });

  it("renders a CSS-style shear: R · [[1, tan x], [tan y, 1]] · S", () => {
    const rotation = 0.4;
    const skew = { x: 0.3, y: -0.2 };
    const scale = { x: 2, y: 1.5 };
    const { matrix } = renderLayout([
      { id: "scale_1", type: "scale", isEnabled: true, parameters: { ...scale, isLinked: false } },
      { id: "rotation_1", type: "rotation", isEnabled: true, parameters: { angle: rotation } },
      { id: "skew_1", type: "skew", isEnabled: true, parameters: skew },
    ]);

    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    // K·S columns, then rotated.
    const column1 = { x: scale.x, y: Math.tan(skew.y) * scale.x };
    const column2 = { x: Math.tan(skew.x) * scale.y, y: scale.y };
    expect(matrix.a).toBeCloseTo(cos * column1.x - sin * column1.y);
    expect(matrix.b).toBeCloseTo(sin * column1.x + cos * column1.y);
    expect(matrix.c).toBeCloseTo(cos * column2.x - sin * column2.y);
    expect(matrix.d).toBeCloseTo(sin * column2.x + cos * column2.y);
  });

  it("keeps the height when shearing horizontally", () => {
    const { matrix } = renderLayout([
      { id: "skew_1", type: "skew", isEnabled: true, parameters: { x: 0.5, y: 0 } },
    ]);
    // The local y axis maps to (tan 0.5, 1): slid sideways, not shortened.
    expect(matrix.c).toBeCloseTo(Math.tan(0.5));
    expect(matrix.d).toBeCloseTo(1);
  });
});
