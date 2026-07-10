import { describe, expect, it } from "vitest";
import {
  CURVE_HISTOGRAM_BIN_COUNT,
  buildCurveHistograms,
  curveHistogramAreaPath,
} from "../curveHistogram";

describe("curve histograms", () => {
  it("accumulates channel, luma, and hue distributions", () => {
    const histograms = buildCurveHistograms(
      new Uint8ClampedArray([
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 0,
      ]),
    );

    expect(histograms.red[CURVE_HISTOGRAM_BIN_COUNT - 1]).toBeGreaterThan(0.6);
    expect(histograms.green[CURVE_HISTOGRAM_BIN_COUNT - 1]).toBeGreaterThan(0.6);
    expect(histograms.blue[CURVE_HISTOGRAM_BIN_COUNT - 1]).toBeGreaterThan(0.6);
    expect(histograms.hue[0]).toBe(1);
    expect(histograms.luma[Math.round(0.7152 * (CURVE_HISTOGRAM_BIN_COUNT - 1))]).toBe(1);
  });

  it("creates a closed SVG area path", () => {
    expect(curveHistogramAreaPath(new Float32Array([0, 1]))).toBe(
      "M 0 100 L 0 100 L 100 0 L 100 100 Z",
    );
  });
});
