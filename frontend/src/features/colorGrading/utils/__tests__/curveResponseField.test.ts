import { describe, expect, it } from "vitest";
import {
  createHueHueFieldBackground,
  createHueSaturationFieldBackground,
  createLumaSaturationFieldBackground,
  relativeSaturation,
  resultantHue,
} from "../curveResponseField";

describe("2D curve response fields", () => {
  it("wraps resultant hue around the neutral centre row", () => {
    expect(resultantHue(0.25, 0)).toBe(0.25);
    expect(resultantHue(0.9, 0.25)).toBeCloseTo(0.15);
    expect(resultantHue(0.1, -0.25)).toBeCloseTo(0.85);
  });

  it("shows multiplicative saturation response around the neutral row", () => {
    expect(relativeSaturation(0.6, 0)).toBe(0.6);
    expect(relativeSaturation(0.6, 0.5)).toBeCloseTo(0.9);
    expect(relativeSaturation(0.6, -0.5)).toBeCloseTo(0.3);
  });

  it("builds self-contained subdued SVG fields for all modifier curves", () => {
    const backgrounds = [
      createHueHueFieldBackground(-0.5, 0.5),
      createHueSaturationFieldBackground(-0.5, 0.5),
      createLumaSaturationFieldBackground(-0.5, 0.5),
    ];
    backgrounds.forEach((background) => {
      expect(background).toContain("data:image/svg+xml");
      expect(decodeURIComponent(background)).toContain("linearGradient");
      expect(decodeURIComponent(background)).toContain('opacity="0.34"');
    });
  });
});
