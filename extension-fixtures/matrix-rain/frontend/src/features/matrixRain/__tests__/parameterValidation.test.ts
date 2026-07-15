import { describe, expect, it } from "vitest";
import { DEFAULT_MATRIX_RAIN_PARAMETERS } from "../constants";
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
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, headWidth: Infinity }),
    ).toBe(false);
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
    // A static field (size) must not accept a scalar object.
    expect(
      validateMatrixRainAuthoredParameters({ ...DEFAULTS, size: spline }),
    ).toBe(false);
  });
});

describe("resolveMatrixRainParameters", () => {
  it("narrows the resolved defaults", () => {
    const resolved = resolveMatrixRainParameters(DEFAULTS);
    expect(resolved).not.toBeNull();
    expect(resolved?.size).toBe(DEFAULT_MATRIX_RAIN_PARAMETERS.size);
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
});
