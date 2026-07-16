import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATRIX_RAIN_PARAMETERS,
  MATRIX_RAIN_CONTROL_GROUPS,
} from "../constants";
import {
  debugModeIndex,
  outputModeIndex,
  resolveMatrixRainParameters,
  validateMatrixRainAuthoredParameters,
} from "../utils/parameterValidation";

const DEFAULTS: Record<string, unknown> = { ...DEFAULT_MATRIX_RAIN_PARAMETERS };

describe("validateMatrixRainAuthoredParameters", () => {
  it("accepts the shipped defaults", () => {
    expect(validateMatrixRainAuthoredParameters(DEFAULTS)).toBe(true);
  });

  it("rejects unknown and missing keys", () => {
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, extra: 1 }),
    ).toBe(false);
    const missing = { ...DEFAULTS };
    delete missing.headColor;
    expect(validateMatrixRainAuthoredParameters(missing)).toBe(false);
  });

  it("rejects out-of-range and non-integer numbers", () => {
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, fallSpeed: 100 }),
    ).toBe(false);
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, size: 10.5 }),
    ).toBe(false);
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, size: 129 }),
    ).toBe(false);
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, verticalSpacing: 2.5 }),
    ).toBe(false);
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, headWidth: Infinity }),
    ).toBe(false);
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, ambientSpawn: 1.1 }),
    ).toBe(false);
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, darkDamping: 8.1 }),
    ).toBe(false);
  });

  it("accepts large source-space glyphs for fitted high-resolution media", () => {
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, size: 96 }),
    ).toBe(true);
  });

  it("rejects malformed colors and unknown enum values", () => {
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, bodyColor: "green" }),
    ).toBe(false);
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, outputMode: "rgb" }),
    ).toBe(false);
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, debugMode: "wild" }),
    ).toBe(false);
  });

  it("preserves spline objects on spline-enabled fields only", () => {
    const spline = { type: "spline", points: [{ time: 0, value: 1 }] };
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, fallSpeed: spline }),
    ).toBe(true);
    // Static grid fields must not accept scalar objects.
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, size: spline }),
    ).toBe(false);
    expect(
      validateMatrixRainAuthoredParameters({
        ...DEFAULTS,
        verticalSpacing: spline,
      }),
    ).toBe(false);
  });
});

describe("resolveMatrixRainParameters", () => {
  it("narrows the resolved defaults", () => {
    const resolved = resolveMatrixRainParameters(DEFAULTS);
    expect(resolved).not.toBeNull();
    expect(resolved?.size).toBe(DEFAULT_MATRIX_RAIN_PARAMETERS.size);
    expect(resolved?.verticalSpacing).toBe(
      DEFAULT_MATRIX_RAIN_PARAMETERS.verticalSpacing,
    );
    expect(resolved?.outputMode).toBe("replaceBlack");
  });

  it("fails closed when the host resolved a value out of range", () => {
    expect(
      resolveMatrixRainParameters({ ...DEFAULTS, rainStrength: Number.NaN }),
    ).toBeNull();
    // A field still carrying a spline object (unresolved) fails closed.
    expect(
      resolveMatrixRainParameters({
        ...DEFAULTS,
        fallSpeed: { type: "spline", points: [] },
      }),
    ).toBeNull();
  });
});

describe("enum indices", () => {
  it("map to their shader integer contract", () => {
    expect(outputModeIndex("replaceBlack")).toBe(0);
    expect(outputModeIndex("matrixOnly")).toBe(1);
    expect(debugModeIndex("none")).toBe(0);
    expect(debugModeIndex("cellGrid")).toBe(1);
    expect(debugModeIndex("proceduralTrail")).toBe(2);
    expect(debugModeIndex("proceduralHead")).toBe(3);
  });

  it("exposes only the compact creative surface", () => {
    expect(
      MATRIX_RAIN_CONTROL_GROUPS.flatMap((group) =>
        group.controls.map((control) => control.name),
      ),
    ).toEqual([
      "rainStrength",
      "contrast",
      "headIntensity",
      "bodyColor",
      "outputMode",
      "fallSpeed",
      "size",
      "pulseDensity",
      "trailDensity",
      "verticalSpacing",
      "signalMode",
      "sourceCoupling",
    ]);
    expect(
      MATRIX_RAIN_CONTROL_GROUPS.flatMap((group) => group.controls),
    ).toHaveLength(12);
  });
});

describe("creative macro resolution", () => {
  it("keeps the detailed defaults neutral at midpoint macros", () => {
    const resolved = resolveMatrixRainParameters(DEFAULTS);
    expect(resolved?.trailHalfLife).toBeCloseTo(0.45, 6);
    expect(resolved?.trailShape).toBeCloseTo(1.8, 6);
    expect(resolved?.ambientSpawn).toBeCloseTo(0.08, 6);
    expect(resolved?.sourceInfluence).toBeCloseTo(0.85, 6);
    expect(resolved?.darkDamping).toBeCloseTo(0.75, 6);
    expect(resolved?.glyphCycleRate).toBeCloseTo(3, 6);
  });

  it("maps trail density and source coupling to related detailed controls", () => {
    const sparse = resolveMatrixRainParameters({
      ...DEFAULTS,
      trailDensity: 0,
      sourceCoupling: 0,
    });
    const dense = resolveMatrixRainParameters({
      ...DEFAULTS,
      trailDensity: 1,
      sourceCoupling: 1,
    });

    expect(dense!.trailHalfLife).toBeGreaterThan(sparse!.trailHalfLife);
    expect(dense!.trailShape).toBeLessThan(sparse!.trailShape);
    expect(dense!.ambientSpawn).toBe(0);
    expect(dense!.sourceInfluence).toBeGreaterThan(sparse!.sourceInfluence);
    expect(dense!.darkDamping).toBeGreaterThan(sparse!.darkDamping);
  });

  it("links brightness and speed to the subordinate render controls", () => {
    const resolved = resolveMatrixRainParameters({
      ...DEFAULTS,
      rainStrength: 2,
      fallSpeed: 16,
    });

    expect(resolved?.rainStrength).toBe(2);
    expect(resolved?.headIntensity).toBe(3);
    expect(resolved?.directShapeStrength).toBe(0.5);
    expect(resolved?.glyphCycleRate).toBe(6);
  });

  it("derives a palette from Tint but preserves a customized legacy ramp", () => {
    const tinted = resolveMatrixRainParameters({
      ...DEFAULTS,
      bodyColor: "#ff0000",
    });
    expect(tinted?.shadowColor).toBe("#4d0000");
    expect(tinted?.headColor).toBe("#ffd6d6");

    const legacy = resolveMatrixRainParameters({
      ...DEFAULTS,
      bodyColor: "#123456",
      shadowColor: "#010203",
      brightColor: "#abcdef",
      headColor: "#fedcba",
    });
    expect(legacy?.shadowColor).toBe("#010203");
    expect(legacy?.bodyColor).toBe("#123456");
    expect(legacy?.brightColor).toBe("#abcdef");
    expect(legacy?.headColor).toBe("#fedcba");
  });
});
