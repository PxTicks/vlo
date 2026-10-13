import { describe, expect, it } from "vitest";
import { createAddTransform } from "../transformFactory";

describe("createAddTransform", () => {
  it("gives each layout transform only its own group's defaults", () => {
    expect(createAddTransform("position")?.parameters).toEqual({ x: 0, y: 0 });
    expect(createAddTransform("scale")?.parameters).toEqual({
      x: 1,
      y: 1,
      isLinked: true,
    });
    expect(createAddTransform("rotation")?.parameters).toEqual({ angle: 0 });
  });
});
