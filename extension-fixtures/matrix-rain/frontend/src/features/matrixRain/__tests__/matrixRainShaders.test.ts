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

  it("uses an independently adjustable vertical glyph-row pitch", () => {
    expect(MATRIX_RAIN_FRAGMENT).toContain("uniform float uVerticalSpacing");
    expect(MATRIX_RAIN_FRAGMENT).toContain(
      "float rowPitch = size + max(uVerticalSpacing, 0.0)",
    );
    expect(MATRIX_RAIN_FRAGMENT).toContain("* glyphRegion");
    expect(MATRIX_RAIN_WGSL).toContain("uVerticalSpacing: f32");
    expect(MATRIX_RAIN_WGSL).toContain(
      "let rowPitch = size + max(mu.uVerticalSpacing, 0.0)",
    );
    expect(MATRIX_RAIN_WGSL).toContain("* glyphRegion");
  });

  it("rasterizes resolution-independent anti-aliased stroke glyphs", () => {
    expect(MATRIX_RAIN_FRAGMENT).toContain("float glyphCoverage");
    expect(MATRIX_RAIN_FRAGMENT).toContain("fwidth(distanceToStroke)");
    expect(MATRIX_RAIN_FRAGMENT).not.toContain("sub.x * 5.0");
    expect(MATRIX_RAIN_WGSL).toContain("fn glyphCoverage");
    expect(MATRIX_RAIN_WGSL).toContain("fwidth(distanceToStroke)");
    expect(MATRIX_RAIN_WGSL).not.toContain("sub.x * 5.0");
  });
});
