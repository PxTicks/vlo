import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLOR_GRADE_PRIMARIES,
  V1_COLOR_MODEL,
  applyColorCurveLut,
  applyAscCdl,
  applyHighlightKnee,
  applyLiftGammaGainOffset,
  bakeColorCurveLut,
  sampleColorCurveLut,
  applyMatrix3,
  applyReferenceColorGrade,
  applyReferenceColorGradePixel,
  applyShadowToe,
  circularHueWeight,
  linearChannelToSrgb,
  rgbToHsv,
  softTrapezoidWeight,
  srgbChannelToLinear,
  whiteBalanceMatrix,
} from "..";

describe("v1 color model", () => {
  it("freezes the SDR slots and authored hue/luma decisions", () => {
    expect(V1_COLOR_MODEL).toMatchObject({
      version: 1,
      input: { decodedSpace: "srgb", primaries: "rec709" },
      working: {
        linearSpace: "scene-linear-rec709",
        gradingSpace: "srgb-rec709",
        hueBasis: "hsv",
        lumaCoefficients: [0.2126, 0.7152, 0.0722],
      },
      display: { space: "srgb" },
      export: {
        primaries: "bt709",
        transfer: "iec61966-2-1",
        matrix: "bt709",
        fullRange: false,
      },
    });
    expect(Object.isFrozen(V1_COLOR_MODEL)).toBe(true);
    expect(Object.isFrozen(V1_COLOR_MODEL.working)).toBe(true);
    expect(Object.isFrozen(V1_COLOR_MODEL.working.lumaCoefficients)).toBe(true);
  });
});

describe("sRGB transfer", () => {
  it.each([
    [0, 0],
    [0.04045, 0.0031308049535603713],
    [0.5, 0.21404114048223255],
    [1, 1],
  ])("linearizes the published pair %f -> %f", (encoded, linear) => {
    expect(srgbChannelToLinear(encoded)).toBeCloseTo(linear, 10);
    // The rounded IEC breakpoint has a documented ~3e-8 discontinuity.
    expect(linearChannelToSrgb(linear)).toBeCloseTo(encoded, 7);
  });
});

describe("matrices and white balance", () => {
  it("is identity at neutral temperature and tint", () => {
    expect(whiteBalanceMatrix(0, 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("warms a neutral linear sample for positive temperature", () => {
    const warm = applyMatrix3(whiteBalanceMatrix(100, 0), [0.5, 0.5, 0.5]);
    expect(warm[0]).toBeGreaterThan(warm[2]);
  });
});

describe("ASC CDL and tone controls", () => {
  it("applies SOP then Rec.709-luma saturation", () => {
    const result = applyAscCdl([0.25, 0.5, 0.75], {
      slope: [2, 1, 0.5],
      offset: [0.1, 0, 0],
      power: [2, 1, 1],
      saturation: 1,
    });
    expect(result[0]).toBeCloseTo(0.36, 10);
    expect(result[1]).toBeCloseTo(0.5, 10);
    expect(result[2]).toBeCloseTo(0.375, 10);
  });

  it("applies lift/gamma/gain/offset wheel deltas", () => {
    const result = applyLiftGammaGainOffset([0.25, 0.5, 0.75], {
      lift: [0.1, 0, 0],
      liftMaster: 0,
      gamma: [0, 0, 0],
      gammaMaster: 0,
      gain: [0, 0.2, 0],
      gainMaster: 0,
      offset: [0, 0, -0.1],
      offsetMaster: 0,
    });
    expect(result).toEqual([
      expect.closeTo(0.35, 10),
      expect.closeTo(0.6, 10),
      expect.closeTo(0.65, 10),
    ]);
  });

  it("keeps disabled toe/knee exactly neutral", () => {
    expect(applyShadowToe(0.1, 0, 0.2)).toBe(0.1);
    expect(applyHighlightKnee(0.8, 1, 0)).toBe(0.8);
  });

  it("joins the knee continuously at both boundaries", () => {
    expect(applyHighlightKnee(0.8, 1, 0.2)).toBeCloseTo(0.8, 10);
    expect(applyHighlightKnee(1.2, 1, 0.2)).toBeCloseTo(1, 10);
  });
});

describe("qualifier weights", () => {
  it("uses smooth, independently sized trapezoid edges", () => {
    expect(softTrapezoidWeight(0.5, 0.4, 0.6, 0.2, 0.1)).toBe(1);
    expect(softTrapezoidWeight(0.3, 0.4, 0.6, 0.2, 0.1)).toBeCloseTo(0.5);
    expect(softTrapezoidWeight(0.65, 0.4, 0.6, 0.2, 0.1)).toBeCloseTo(0.5);
  });

  it("wraps HSV hue across the seam", () => {
    expect(circularHueWeight(0.99, 0.01, 0.1, 0.02, 0.02)).toBe(1);
    expect(circularHueWeight(0.5, 0.01, 0.1, 0.02, 0.02)).toBe(0);
  });
});

describe("reference color-grade pipeline", () => {
  it("is neutral at defaults", () => {
    const input = [0.12, 0.5, 0.91] as const;
    const output = applyReferenceColorGrade(input);
    output.forEach((channel, index) => {
      // The reference deliberately traverses the shader's float32 curve LUT.
      expect(channel).toBeCloseTo(input[index], 6);
    });
  });

  it("performs exposure in linear light", () => {
    const output = applyReferenceColorGrade([0.5, 0.5, 0.5], {
      ...DEFAULT_COLOR_GRADE_PRIMARIES,
      exposure: 1,
    });
    const expected = linearChannelToSrgb(srgbChannelToLinear(0.5) * 2);
    expect(output).toEqual([
      expect.closeTo(expected, 7),
      expect.closeTo(expected, 7),
      expect.closeTo(expected, 7),
    ]);
  });

  it("unpremultiplies and re-premultiplies transparent edges", () => {
    const output = applyReferenceColorGradePixel([0.25, 0.1, 0.05, 0.5], {
      ...DEFAULT_COLOR_GRADE_PRIMARIES,
      hueRotate: 120,
    });
    expect(output[3]).toBe(0.5);
    expect(output.slice(0, 3).every((channel) => Number.isFinite(channel))).toBe(true);
    expect(applyReferenceColorGradePixel([0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
  });

  it("defines hue using the frozen HSV basis", () => {
    expect(rgbToHsv([1, 0, 0])).toEqual([0, 1, 1]);
    const green = rgbToHsv([0, 1, 0]);
    expect(green[0]).toBeCloseTo(1 / 3, 14);
    expect(green.slice(1)).toEqual([1, 1]);
  });

  it("preserves headroom while applying channel curves", () => {
    const output = applyReferenceColorGrade([0.8, 0.4, 0.2], {
      ...DEFAULT_COLOR_GRADE_PRIMARIES,
      gainMaster: 1,
      curveR: [
        { x: 0, y: 0 },
        { x: 1, y: 0.5 },
      ],
    });
    expect(output[0]).toBeCloseTo(1.1, 5);
    expect(output[1]).toBeCloseTo(0.8, 5);
    expect(output[2]).toBeCloseTo(0.4, 5);
  });

  it("uses the same manually interpolated 1024-sample curve LUT", () => {
    const lut = bakeColorCurveLut({
      curveMaster: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.25 },
        { x: 1, y: 1 },
      ],
    });
    expect(sampleColorCurveLut(lut, 0, 0, 0.5)).toBeCloseTo(0.25, 5);
  });

  it("keeps an identity curve silent outside the LUT domain", () => {
    const identity = bakeColorCurveLut({});
    const output = applyColorCurveLut([1.4, 0.5, -0.2], identity);
    expect(output[0]).toBeCloseTo(1.4, 6);
    expect(output[1]).toBeCloseTo(0.5, 6);
    expect(output[2]).toBeCloseTo(-0.2, 6);
  });

  it("does not change a grade when an identity point is inserted", () => {
    const parameters = {
      ...DEFAULT_COLOR_GRADE_PRIMARIES,
      exposure: 2,
    };
    const baseline = applyReferenceColorGrade([0.8, 0.4, 0.2], parameters);
    const withRedundantPoint = applyReferenceColorGrade([0.8, 0.4, 0.2], {
      ...parameters,
      curveMaster: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
      ],
    });
    expect(withRedundantPoint).toEqual(
      baseline.map((channel) => expect.closeTo(channel, 6)),
    );
  });
});
