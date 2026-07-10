import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR_CURVES } from "../../../../../../core/color";
import { analyzeColorGradeHistograms } from "../colorGradeHistogramAnalysis";
import { normalizeColorGradeLayer } from "../fusedColorGradeParameters";

function peakIndex(values: Float32Array): number {
  let peak = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > values[peak]) peak = index;
  }
  return peak;
}

describe("color grade histogram analysis", () => {
  it("uses upstream grades for the selected curve input and stops after curves", () => {
    const grades = [
      normalizeColorGradeLayer({
        transformId: "upstream",
        parameters: { exposure: 1 },
      }),
      normalizeColorGradeLayer({
        transformId: "selected",
        parameters: {
          saturation: 0,
          ...DEFAULT_COLOR_CURVES,
          curveMaster: [
            { x: 0, y: 0 },
            { x: 1, y: 0.5 },
          ],
        },
      }),
    ];
    const result = analyzeColorGradeHistograms(
      new Uint8ClampedArray([64, 64, 64, 255]),
      grades,
      new Set(["selected"]),
    ).get("selected");

    expect(result).toBeDefined();
    expect(
      peakIndex(result?.snapshot.before.luma ?? new Float32Array()),
    ).toBeGreaterThan(31);
    expect(
      peakIndex(result?.snapshot.after.luma ?? new Float32Array()),
    ).toBeLessThan(
      peakIndex(result?.snapshot.before.luma ?? new Float32Array()),
    );
  });
});
