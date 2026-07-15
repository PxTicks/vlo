import { describe, expect, it } from "vitest";
import {
  MATRIX_RAIN_FRAGMENT,
  MATRIX_RAIN_VERTEX,
} from "../shaders/matrixRainGl";
import { MATRIX_RAIN_WGSL } from "../shaders/matrixRainWgsl";

describe("Matrix Rain WebGL programs", () => {
  it("declare GLSL ES 3.00 before using unsigned integer operations", () => {
    expect(MATRIX_RAIN_VERTEX.trimStart()).toMatch(/^#version 300 es\b/);
    expect(MATRIX_RAIN_FRAGMENT.trimStart()).toMatch(/^#version 300 es\b/);
    expect(MATRIX_RAIN_FRAGMENT).toContain("uint pcgHash");
  });

  it("converts filter-frame coordinates to source-local pixels", () => {
    expect(MATRIX_RAIN_FRAGMENT).toContain("uniform vec2 uContentSize");
    expect(MATRIX_RAIN_FRAGMENT).toContain("contentSize / frameSize");
    expect(MATRIX_RAIN_WGSL).toContain("uContentSize: vec2<f32>");
    expect(MATRIX_RAIN_WGSL).toContain("contentSize / frameSize");
  });
});
