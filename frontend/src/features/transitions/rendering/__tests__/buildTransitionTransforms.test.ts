import { describe, expect, it } from "vitest";
import type { Transition } from "../../../../types/TimelineTypes";
import { buildTransitionTransforms } from "../buildTransitionTransforms";

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
