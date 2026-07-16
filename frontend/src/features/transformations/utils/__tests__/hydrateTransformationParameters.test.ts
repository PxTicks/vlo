import { describe, expect, it } from "vitest";
import { layoutDefinition } from "../../catalogue/layout/layoutDefinition";
import { hydrateTransformationParameters } from "../hydrateTransformationParameters";

const hydratingLayoutDefinition = {
  ...layoutDefinition,
  hydrateMissingParameters: true,
};

describe("hydrateTransformationParameters", () => {
  it("hydrates only the active group for multi-type native definitions", () => {
    expect(
      hydrateTransformationParameters(
        hydratingLayoutDefinition,
        { x: 25 },
        "position",
      ),
    ).toEqual({ x: 25, y: 0 });
    expect(
      hydrateTransformationParameters(
        hydratingLayoutDefinition,
        { x: 2 },
        "scale",
      ),
    ).toEqual({ x: 2, y: 1, isLinked: true });
  });

  it("returns the original parameter object when no defaults are missing", () => {
    const parameters = { angle: 0 };
    expect(
      hydrateTransformationParameters(
        hydratingLayoutDefinition,
        parameters,
        "rotation",
      ),
    ).toBe(parameters);
  });

  it("leaves non-opted-in native definitions unchanged", () => {
    const parameters = { x: 25 };
    expect(
      hydrateTransformationParameters(layoutDefinition, parameters, "position"),
    ).toBe(parameters);
  });
});
