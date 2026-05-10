import { describe, expect, it } from "vitest";
import { createOpaqueOutputColorMatrixFilter } from "../outputTransformStack";

describe("outputTransformStack", () => {
  it("creates an opaque output filter that forces alpha to one", () => {
    const filter = createOpaqueOutputColorMatrixFilter();

    expect(Array.from(filter.matrix)).toEqual([
      1, 0, 0, 0, 0,
      0, 1, 0, 0, 0,
      0, 0, 1, 0, 0,
      0, 0, 0, 0, 1,
    ]);
  });
});
