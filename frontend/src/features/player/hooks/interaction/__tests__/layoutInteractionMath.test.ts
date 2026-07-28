import { describe, expect, it } from "vitest";
import { lockCornerScaleAspectRatio } from "../layoutInteractionMath";

describe("lockCornerScaleAspectRatio", () => {
  it("preserves independent axis signs when a corner crosses one axis", () => {
    expect(
      lockCornerScaleAspectRatio(
        "se",
        { x: 1, y: 1 },
        { x: -2, y: 0.5 },
      ),
    ).toEqual({ x: -2, y: 2 });
  });

  it("links an edge drag when requested without changing its flip axis", () => {
    expect(
      lockCornerScaleAspectRatio(
        "e",
        { x: 1, y: 1 },
        { x: -2, y: 1 },
        true,
      ),
    ).toEqual({ x: -2, y: 2 });
  });

  it("leaves unlinked edge drags independent", () => {
    expect(
      lockCornerScaleAspectRatio(
        "e",
        { x: 1, y: 1 },
        { x: -2, y: 1 },
      ),
    ).toEqual({ x: -2, y: 1 });
  });
});
