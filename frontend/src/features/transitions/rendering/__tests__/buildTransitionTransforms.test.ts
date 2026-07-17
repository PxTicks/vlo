import { describe, expect, it } from "vitest";
import type { ClipTransform, Transition } from "../../../../types/TimelineTypes";
import type { GenericFilterTransform } from "../../../transformations/types";
import { buildTransitionTransforms } from "../buildTransitionTransforms";

const filterName = (t: ClipTransform): string | undefined =>
  (t as GenericFilterTransform).filterName;

function transition(
  type: Transition["type"],
  parameters: Record<string, unknown> = {},
): Transition {
  return {
    id: "transition-1",
    type,
    outgoingClipId: "outgoing",
    incomingClipId: "incoming",
    parameters: { easing: "linear", ...parameters },
  };
}

describe("buildTransitionTransforms", () => {
  it("crossfades dissolve sides", () => {
    const dimensions = { width: 1920, height: 1080 };
    expect(
      buildTransitionTransforms(
        transition("dissolve"),
        "outgoing",
        0.5,
        dimensions,
      )[0].parameters.alpha,
    ).toBe(0.5);
    expect(
      buildTransitionTransforms(
        transition("dissolve"),
        "incoming",
        0.5,
        dimensions,
      )[0].parameters.alpha,
    ).toBe(0.5);
  });

  it("moves slide-out/in sides in opposite directions", () => {
    const dimensions = { width: 100, height: 50 };
    const definition = transition("slideOutIn", {
      direction: "left",
      distance: 1,
    });
    expect(
      buildTransitionTransforms(definition, "outgoing", 0.5, dimensions)[0]
        .parameters,
    ).toEqual({ x: -50, y: 0 });
    expect(
      buildTransitionTransforms(definition, "incoming", 0.5, dimensions)[0]
        .parameters,
    ).toEqual({ x: 50, y: 0 });
  });

  it("cross-zooms outgoing up and incoming down to unity", () => {
    const dimensions = { width: 100, height: 50 };
    const definition = transition("zoom", { scale: 2 });
    const outgoing = buildTransitionTransforms(
      definition,
      "outgoing",
      0.5,
      dimensions,
    );
    expect(outgoing.find((t) => t.type === "scale")?.parameters).toEqual({
      x: 1.5,
      y: 1.5,
    });
    expect(
      outgoing.find((t) => filterName(t) === "AlphaFilter")?.parameters.alpha,
    ).toBe(0.5);
    const incoming = buildTransitionTransforms(
      definition,
      "incoming",
      1,
      dimensions,
    );
    // Incoming settles to unity scale and full opacity at the end.
    expect(incoming.find((t) => t.type === "scale")?.parameters).toEqual({
      x: 1,
      y: 1,
    });
    expect(
      incoming.find((t) => filterName(t) === "AlphaFilter")?.parameters.alpha,
    ).toBe(1);
  });

  it("spins a full turn scaled by the rotations parameter and direction", () => {
    const dimensions = { width: 100, height: 50 };
    const cw = buildTransitionTransforms(
      transition("spin", { rotations: 1, direction: "clockwise" }),
      "outgoing",
      1,
      dimensions,
    );
    expect(cw.find((t) => t.type === "rotation")?.parameters.angle).toBeCloseTo(
      Math.PI * 2,
    );
    const ccw = buildTransitionTransforms(
      transition("spin", { rotations: 2, direction: "counterclockwise" }),
      "outgoing",
      1,
      dimensions,
    );
    expect(ccw.find((t) => t.type === "rotation")?.parameters.angle).toBeCloseTo(
      -Math.PI * 4,
    );
  });

  it("peaks whip-pan blur at the midpoint and clears it at the ends", () => {
    const dimensions = { width: 100, height: 50 };
    const definition = transition("whipPan", { direction: "left", blur: 12 });
    const blurAt = (progress: number) =>
      buildTransitionTransforms(definition, "outgoing", progress, dimensions).find(
        (t) => filterName(t) === "BlurFilter",
      )?.parameters.strength as number;
    expect(blurAt(0)).toBeCloseTo(0);
    expect(blurAt(1)).toBeCloseTo(0);
    expect(blurAt(0.5)).toBeCloseTo(12);
  });

  it("reaches the dip color at the midpoint", () => {
    const dimensions = { width: 100, height: 50 };
    expect(
      buildTransitionTransforms(
        transition("dipToColor"),
        "outgoing",
        0.5,
        dimensions,
      )[0].parameters.alpha,
    ).toBe(0);
    expect(
      buildTransitionTransforms(
        transition("dipToColor"),
        "incoming",
        0.5,
        dimensions,
      )[0].parameters.alpha,
    ).toBe(0);
  });
});
