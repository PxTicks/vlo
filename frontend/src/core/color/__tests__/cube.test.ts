import { describe, expect, it } from "vitest";
import {
  CubeLutParseError,
  applyReferenceColorGrade,
  bakeColorGradeCube,
  createIdentityCubeLut,
  expandCubeLutTo3d,
  parseCubeLut,
  sampleCubeLut,
  serializeCubeLut,
  type ColorGradeReferenceParameters,
  type CubeLut,
  type Rgb,
} from "..";
import { DEFAULT_COLOR_GRADE_PRIMARIES } from "../referencePipeline";

const SIMPLE_3D_CUBE = `# Written by a grading tool
TITLE "Teal Push"
LUT_3D_SIZE 2

0.0 0.0 0.0
1.0 0.1 0.0
0.0 0.9 0.1
1.0 1.0 0.1
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
0.9 1.0 1.0
`;

describe(".cube parsing", () => {
  it("parses a 3D LUT with title, comments, and r-fastest data order", () => {
    const lut = parseCubeLut(SIMPLE_3D_CUBE);
    expect(lut.title).toBe("Teal Push");
    expect(lut.dimensions).toBe(3);
    expect(lut.size).toBe(2);
    expect(lut.domainMin).toEqual([0, 0, 0]);
    expect(lut.domainMax).toEqual([1, 1, 1]);
    // Lattice (r=1, g=1, b=0) is the fourth row.
    expect([...lut.data.slice(9, 12)]).toEqual([1, 1, Math.fround(0.1)]);
    expect(lut.data).toHaveLength(2 * 2 * 2 * 3);
  });

  it("parses DOMAIN_MIN/DOMAIN_MAX and 1D LUTs", () => {
    const lut = parseCubeLut(
      [
        "LUT_1D_SIZE 3",
        "DOMAIN_MIN -0.5 0.0 0.0",
        "DOMAIN_MAX 0.5 1.0 2.0",
        "0.0 0.0 0.0",
        "0.25 0.5 0.75",
        "1.0 1.0 1.0",
      ].join("\n"),
    );
    expect(lut.dimensions).toBe(1);
    expect(lut.size).toBe(3);
    expect(lut.domainMin).toEqual([-0.5, 0, 0]);
    expect(lut.domainMax).toEqual([0.5, 1, 2]);
    // Domain mapping: red 0.0 sits mid-domain; blue 2.0 is the domain top.
    expect(sampleCubeLut(lut, [0, 0.5, 2])).toEqual([0.25, 0.5, 1]);
  });

  it("maps the legacy IRIDAS input-range form onto the domain", () => {
    const lut = parseCubeLut(
      ["LUT_1D_SIZE 2", "LUT_1D_INPUT_RANGE 0.0 2.0", "0 0 0", "1 1 1"].join(
        "\n",
      ),
    );
    expect(lut.domainMax).toEqual([2, 2, 2]);
    expect(sampleCubeLut(lut, [1, 1, 1])).toEqual([0.5, 0.5, 0.5]);
  });

  it("rejects malformed files with line context", () => {
    expect(() => parseCubeLut("LUT_3D_SIZE 66\n")).toThrow(CubeLutParseError);
    expect(() => parseCubeLut("LUT_3D_SIZE 2\n0 0 0\n")).toThrow(
      /Expected 8 data rows/,
    );
    expect(() => parseCubeLut("0 0 0\n")).toThrow(/before LUT_1D_SIZE/);
    expect(() => parseCubeLut("LUT_3D_SIZE 2\nnope\n")).toThrow(/line 2/);
    expect(() =>
      parseCubeLut(
        ["LUT_1D_SIZE 2", "DOMAIN_MIN 1 1 1", "DOMAIN_MAX 0 0 0", "0 0 0", "1 1 1"].join(
          "\n",
        ),
      ),
    ).toThrow(/DOMAIN_MAX/);
  });

  it("round-trips through serialize → parse", () => {
    const original = parseCubeLut(SIMPLE_3D_CUBE);
    const reparsed = parseCubeLut(serializeCubeLut(original));
    expect(reparsed.title).toBe(original.title);
    expect(reparsed.size).toBe(original.size);
    expect([...reparsed.data]).toEqual([...original.data]);

    const domained: CubeLut = {
      ...original,
      title: null,
      domainMin: [-0.125, 0, 0],
      domainMax: [1, 1, 0.875],
    };
    const reparsedDomain = parseCubeLut(serializeCubeLut(domained));
    expect(reparsedDomain.domainMin).toEqual([-0.125, 0, 0]);
    expect(reparsedDomain.domainMax).toEqual([1, 1, 0.875]);
  });
});

describe("tetrahedral sampling", () => {
  it("is exact on the identity lattice", () => {
    const lut = createIdentityCubeLut(5);
    const probes: Rgb[] = [
      [0, 0, 0],
      [1, 1, 1],
      [0.25, 0.5, 0.75],
      [0.9, 0.1, 0.3],
      [0.5, 0.5, 0.5],
    ];
    for (const probe of probes) {
      const sampled = sampleCubeLut(lut, probe);
      expect(sampled[0]).toBeCloseTo(probe[0], 6);
      expect(sampled[1]).toBeCloseTo(probe[1], 6);
      expect(sampled[2]).toBeCloseTo(probe[2], 6);
    }
  });

  it("interpolates each tetrahedron with linear precision per axis", () => {
    const lut = parseCubeLut(SIMPLE_3D_CUBE);
    // Along the red axis at g=b=0 the output red is linear 0→1.
    expect(sampleCubeLut(lut, [0.25, 0, 0])[0]).toBeCloseTo(0.25, 6);
    // Corner values are reproduced exactly (within float32 storage).
    const corner = sampleCubeLut(lut, [1, 1, 0]);
    expect(corner[0]).toBeCloseTo(1, 6);
    expect(corner[1]).toBeCloseTo(1, 6);
    expect(corner[2]).toBeCloseTo(0.1, 6);
    // Inputs outside the domain clamp to the lattice edge.
    const clamped = sampleCubeLut(lut, [2, -1, 0]);
    expect(clamped[0]).toBeCloseTo(1, 6);
    expect(clamped[1]).toBeCloseTo(0.1, 6);
    expect(clamped[2]).toBeCloseTo(0, 6);
  });

  it("expands 1D LUTs to a 3D lattice that samples identically", () => {
    const lut1d = parseCubeLut(
      [
        "LUT_1D_SIZE 4",
        "0 0 0",
        "0.4 0.3 0.1",
        "0.7 0.8 0.5",
        "1 1 1",
      ].join("\n"),
    );
    const lut3d = expandCubeLutTo3d(lut1d);
    expect(lut3d.dimensions).toBe(3);
    expect(lut3d.size).toBe(4);
    for (const probe of [
      [0.1, 0.5, 0.9],
      [0.33, 0.33, 0.33],
      [1, 0, 0.66],
    ] as const) {
      const direct = sampleCubeLut(lut1d, probe);
      const expanded = sampleCubeLut(lut3d, probe);
      expect(expanded[0]).toBeCloseTo(direct[0], 6);
      expect(expanded[1]).toBeCloseTo(direct[1], 6);
      expect(expanded[2]).toBeCloseTo(direct[2], 6);
    }
  });
});

describe("grade → .cube export", () => {
  const gradeParameters: ColorGradeReferenceParameters = {
    ...DEFAULT_COLOR_GRADE_PRIMARIES,
    exposure: 0.4,
    temperature: 12,
    contrast: 1.15,
    saturation: 1.2,
    gainR: 0.08,
    liftB: -0.04,
    kneeSoftness: 0.2,
  };

  it("applies a baked grade LUT like the direct grade", () => {
    const baked = bakeColorGradeCube(gradeParameters);
    expect(baked.size).toBe(33);
    const probes: Rgb[] = [
      [0.1, 0.2, 0.3],
      [0.8, 0.5, 0.2],
      [0.45, 0.45, 0.45],
      [0.95, 0.9, 0.05],
    ];
    for (const probe of probes) {
      const direct = applyReferenceColorGrade(probe, gradeParameters).map(
        (channel) => Math.max(0, Math.min(1, channel)),
      );
      const viaLut = sampleCubeLut(baked, probe);
      // 33³ lattice resolution bounds the interpolation error.
      expect(viaLut[0]).toBeCloseTo(direct[0], 2);
      expect(viaLut[1]).toBeCloseTo(direct[1], 2);
      expect(viaLut[2]).toBeCloseTo(direct[2], 2);
    }
  });

  it("bakes the qualifier composite and an upstream creative LUT into the export", () => {
    const identity = createIdentityCubeLut(9);
    const withQualifier: ColorGradeReferenceParameters = {
      ...gradeParameters,
      qualifierEnabled: true,
      mattePreview: true,
      lutIntensity: 1,
    };
    const baked = bakeColorGradeCube(withQualifier, { lut: identity, title: "Grade" });
    expect(baked.title).toBe("Grade");
    // Matte preview must not leak into the export: with a full-range default
    // qualifier the matte would be flat white, but the export keeps grading.
    const dark = sampleCubeLut(baked, [0.05, 0.05, 0.05]);
    const bright = sampleCubeLut(baked, [0.9, 0.9, 0.9]);
    expect(dark).not.toEqual(bright);

    const roundTripped = parseCubeLut(serializeCubeLut(baked));
    expect(roundTripped.size).toBe(33);
    expect(roundTripped.data.length).toBe(baked.data.length);
  });
});
