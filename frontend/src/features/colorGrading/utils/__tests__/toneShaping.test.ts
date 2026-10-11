import { describe, expect, it } from "vitest";
import { applyToneCurve } from "../../../../core/color";
import {
  effectiveKneeThreshold,
  KNEE_OFF_THRESHOLD,
  toneMacroPosition,
  toneMacroStrength,
  toneMacroUpdate,
  type ToneParameters,
} from "../toneShaping";

const INACTIVE: ToneParameters = {
  kneeThreshold: 1,
  kneeSoftness: 0,
  toeAmount: 0,
  toeSoftness: 0,
};

function curveAt(input: number, parameters: Partial<ToneParameters>): number {
  return applyToneCurve([input, input, input], {
    contrast: 1,
    pivot: 0.435,
    ...INACTIVE,
    ...parameters,
  })[0];
}

describe("tone shaping macros", () => {
  it("keeps zero strength mathematically inactive", () => {
    expect(toneMacroUpdate("highlight", 0)).toEqual({
      kneeThreshold: KNEE_OFF_THRESHOLD,
      kneeSoftness: 0,
    });
    expect(toneMacroUpdate("shadow", 0)).toEqual({
      toeAmount: 0,
      toeSoftness: 0,
    });
  });

  it("activates both parameters with one highlight or shadow adjustment", () => {
    const highlight = toneMacroUpdate("highlight", 0.5);
    const shadow = toneMacroUpdate("shadow", 0.5);
    expect(highlight.kneeThreshold).toBeCloseTo(1.15);
    expect(highlight.kneeSoftness).toBeCloseTo(0.15);
    expect(shadow).toEqual({ toeAmount: 0.5, toeSoftness: 0.25 });
    expect(
      toneMacroStrength("highlight", { ...INACTIVE, ...highlight }),
    ).toBeCloseTo(0.5);
    expect(toneMacroStrength("shadow", { ...INACTIVE, ...shadow })).toBeCloseTo(
      0.5,
    );
  });

  it("keeps the full highlight macro where it was", () => {
    const full = toneMacroUpdate("highlight", 1);
    expect(full.kneeThreshold).toBeCloseTo(0.8);
    expect(full.kneeSoftness).toBeCloseTo(0.3);
  });

  it("engages the highlight knee without flattening super-whites", () => {
    // Downstream curves and stacked grades can bring super-whites back into
    // range, so a barely engaged knee must leave them nearly untouched.
    const slight = toneMacroUpdate("highlight", 0.005);
    for (const input of [0.5, 1, 1.2, 1.45]) {
      expect(curveAt(input, slight)).toBeCloseTo(input, 3);
    }
  });

  it("draws an inactive knee at the top of the domain", () => {
    expect(effectiveKneeThreshold(INACTIVE)).toBe(KNEE_OFF_THRESHOLD);
    expect(
      effectiveKneeThreshold({
        ...INACTIVE,
        kneeThreshold: 0.9,
        kneeSoftness: 0.1,
      }),
    ).toBe(0.9);
  });

  it("continues from exact values off the macro line without snapping", () => {
    const start = { ...INACTIVE, kneeThreshold: 0.9, kneeSoftness: 0.1 };
    const position = toneMacroPosition("highlight", start);
    expect(toneMacroUpdate("highlight", position, start)).toEqual({
      kneeThreshold: expect.closeTo(0.9, 10),
      kneeSoftness: expect.closeTo(0.1, 10),
    });
    // The transition scales with the threshold's distance from the top.
    const halfway = toneMacroUpdate("highlight", position / 2, start);
    expect(halfway.kneeThreshold).toBeCloseTo(1.2);
    expect(halfway.kneeSoftness).toBeCloseTo(0.05);

    const toeStart = { ...INACTIVE, toeAmount: 0.8, toeSoftness: 0.1 };
    expect(
      toneMacroUpdate(
        "shadow",
        toneMacroPosition("shadow", toeStart),
        toeStart,
      ),
    ).toEqual({
      toeAmount: expect.closeTo(0.8, 10),
      toeSoftness: expect.closeTo(0.1, 10),
    });
  });

  it.each([1.5, 1.499])(
    "continues an active knee at threshold %s without dropping its transition",
    (kneeThreshold) => {
      const start = { ...INACTIVE, kneeThreshold, kneeSoftness: 0.2 };
      const position = toneMacroPosition("highlight", start);
      expect(toneMacroUpdate("highlight", position, start)).toEqual({
        kneeThreshold: expect.closeTo(kneeThreshold, 10),
        kneeSoftness: expect.closeTo(0.2, 10),
      });
      const nudged = toneMacroUpdate("highlight", position + 0.01, start);
      expect(nudged.kneeSoftness).toBeCloseTo(0.2, 2);
      // Towards full, the transition still meets the full macro.
      expect(toneMacroUpdate("highlight", 1, start).kneeSoftness).toBeCloseTo(
        0.3,
      );
    },
  );

  it("reports positions past the macro range for exact edits", () => {
    expect(
      toneMacroPosition("highlight", {
        ...INACTIVE,
        kneeThreshold: 0.5,
        kneeSoftness: 0.2,
      }),
    ).toBeCloseTo(1 / 0.7);
    expect(
      toneMacroStrength("highlight", {
        ...INACTIVE,
        kneeThreshold: 0.5,
        kneeSoftness: 0.2,
      }),
    ).toBe(1);
  });
});
