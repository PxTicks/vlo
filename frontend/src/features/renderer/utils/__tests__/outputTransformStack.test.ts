import { describe, expect, it } from "vitest";
import {
  createOpaqueOutputColorMatrixFilter,
  createTransparentAreaNeutralGrayOutputColorMatrixFilter,
} from "../outputTransformStack";

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

  it("creates a neutral-gray matte filter for transparent regions", () => {
    const filter = createTransparentAreaNeutralGrayOutputColorMatrixFilter();

    expect(Array.from(filter.matrix)).toEqual([
      1, 0, 0, -0.5, 0.5,
      0, 1, 0, -0.5, 0.5,
      0, 0, 1, -0.5, 0.5,
      0, 0, 0, 0, 1,
    ]);
  });
});
