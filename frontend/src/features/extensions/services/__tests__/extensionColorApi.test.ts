import { describe, expect, it } from "vitest";
import {
  extensionColorApi,
  ExtensionColorGradeError,
} from "../extensionColorApi";
import {
  DEFAULT_COLOR_GRADE_PRIMARIES,
  createReferenceColorGradeEvaluator,
} from "../../../../core/color";
import { colorGradeDefinition } from "../../../transformations/catalogue/filters/colorGrade/definition";
import type { ExtensionTimelineTransformSnapshot } from "../../types";

const { grade } = extensionColorApi;

function gradeTransform(
  parameters: Record<string, unknown>,
  overrides: Partial<ExtensionTimelineTransformSnapshot> = {},
): ExtensionTimelineTransformSnapshot {
  return {
    id: "transform-1",
    type: "filter",
    filterName: "ColorGradeFilter",
    isEnabled: true,
    parameters,
    ...overrides,
  } as ExtensionTimelineTransformSnapshot;
}

describe("api.color.grade", () => {
  describe("parseTransform", () => {
    it("returns the authored grade for a color grade transform", () => {
      const parsed = grade.parseTransform(gradeTransform({ exposure: 1.5 }));
      expect(parsed).not.toBeNull();
      expect(parsed?.exposure).toBe(1.5);
      expect(parsed?.colorModel).toEqual({ version: 1, gradingSpace: "srgb-rec709" });
    });

    it("accepts the host's canonical default grade parameters", () => {
      expect(colorGradeDefinition.defaultParameters).toBeDefined();
      expect(() =>
        grade.parseTransform(
          gradeTransform(colorGradeDefinition.defaultParameters ?? {}),
        ),
      ).not.toThrow();
    });

    it("returns null for a transform that is not a grade", () => {
      expect(
        grade.parseTransform(
          gradeTransform({ blur: 4 }, { filterName: "BlurFilter" }),
        ),
      ).toBeNull();
      expect(
        grade.parseTransform(gradeTransform({}, { type: "position" })),
      ).toBeNull();
    });

    it("fails closed on an unsupported color model rather than coercing to V1", () => {
      expect(() =>
        grade.parseTransform(
          gradeTransform({ colorModel: { version: 2 }, exposure: 1 }),
        ),
      ).toThrow(ExtensionColorGradeError);
      expect(() =>
        grade.parseTransform(
          gradeTransform({
            colorModel: { version: 1, gradingSpace: "future-wide-gamut" },
          }),
        ),
      ).toThrow(ExtensionColorGradeError);
      expect(() =>
        grade.parseTransform(
          gradeTransform({
            colorModel: {
              version: 1,
              gradingSpace: "srgb-rec709",
              futureField: true,
            },
          }),
        ),
      ).toThrow(ExtensionColorGradeError);
    });

    it("rejects unknown parameters and invalid static values", () => {
      expect(() =>
        grade.parseTransform(gradeTransform({ exposuer: 1 })),
      ).toThrow(/unknown grade parameter/i);
      expect(() =>
        grade.parseTransform(gradeTransform({ qualifierEnabled: "yes" })),
      ).toThrow(/boolean/i);
    });

    it("preserves an authored animation object through the read path", () => {
      const spline = {
        type: "spline",
        points: [
          { time: 0, value: 0 },
          { time: 1, value: 2 },
        ],
      };
      const parsed = grade.parseTransform(gradeTransform({ exposure: spline }));
      expect(parsed?.exposure).toEqual(spline);
    });
  });

  describe("normalize", () => {
    it("fills defaults and clamps out-of-range values", () => {
      const normalized = grade.normalize({ contrast: -5, toeAmount: 9 });
      expect(normalized.contrast).toBe(0);
      expect(normalized.toeAmount).toBe(1);
      expect(normalized.pivot).toBe(DEFAULT_COLOR_GRADE_PRIMARIES.pivot);
    });

    it("orders an inverted qualifier range", () => {
      const normalized = grade.normalize({ satLo: 0.9, satHi: 0.2 });
      expect(normalized.satLo).toBe(0.2);
      expect(normalized.satHi).toBe(0.9);
    });

    it("throws on an animated value instead of silently erasing it", () => {
      expect(() =>
        grade.normalize({
          exposure: {
            type: "spline",
            points: [{ time: 0, value: 1 }],
          },
        } as never),
      ).toThrow(/animated/i);
    });

    it("rejects unknown, mistyped, and non-JSON values", () => {
      expect(() => grade.normalize({ exposuer: 1 } as never)).toThrow(
        /unknown grade parameter/i,
      );
      expect(() => grade.normalize({ exposure: "bright" } as never)).toThrow(
        /finite number/i,
      );
      expect(() => grade.normalize({ exposure: Number.NaN } as never)).toThrow(
        /JSON object/i,
      );
      expect(() =>
        grade.normalize({ exposure: undefined } as never),
      ).toThrow(/field 'exposure'.*undefined/i);
    });
  });

  describe("normalizePatch", () => {
    it("clamps only the fields present, leaving the rest of a grade untouched", () => {
      const patch = grade.normalizePatch({ saturation: -2 });
      expect(patch).toEqual({ saturation: 0 });
      expect(patch.exposure).toBeUndefined();
      expect(patch.contrast).toBeUndefined();
    });

    it("rejects unknown keys so a typo cannot become a silent no-op", () => {
      expect(() =>
        grade.normalizePatch({ _uiTab: "wheels", exposure: 1 } as never),
      ).toThrow(/unknown grade parameter/i);
    });
  });

  describe("resolve", () => {
    it("evaluates an authored spline at the requested source time", () => {
      const authored = grade.parseTransform(
        gradeTransform({
          exposure: {
            type: "spline",
            points: [
              { time: 0, value: 0 },
              { time: 10, value: 2 },
            ],
          },
        }),
      );
      expect(authored).not.toBeNull();
      const resolved = grade.resolve(authored!, { sourceTime: 5 });
      expect(resolved.exposure).toBeCloseTo(1, 5);
    });

    it("evaluates an SDK keyframed scalar through the renderer resolver", () => {
      const authored = grade.parseTransform(
        gradeTransform({
          exposure: {
            type: "extension-keyframed-scalar",
            keyframes: [
              {
                time: 0,
                value: 0,
                outgoing: {
                  extensionId: "vlo.core",
                  typeId: "monotone-cubic",
                  schemaVersion: 1,
                  data: null,
                },
              },
              { time: 10, value: 2 },
            ],
          },
        }),
      );

      expect(grade.resolve(authored!, { sourceTime: 5 }).exposure).toBeCloseTo(
        1,
        5,
      );
    });

    it("rejects a non-finite source time", () => {
      expect(() =>
        grade.resolve(grade.defaults, { sourceTime: Number.NaN }),
      ).toThrow(ExtensionColorGradeError);
    });

    it("rejects malformed or unsupported authored animation objects", () => {
      expect(() =>
        grade.resolve(
          {
            colorModel: { version: 1, gradingSpace: "srgb-rec709" },
            exposure: { type: "spline", points: [] },
          },
          { sourceTime: 0 },
        ),
      ).toThrow(/at least one spline point/i);
      expect(() =>
        grade.resolve(
          {
            colorModel: { version: 1, gradingSpace: "srgb-rec709" },
            exposure: { type: "future-animation" },
          } as never,
          { sourceTime: 0 },
        ),
      ).toThrow(/unsupported animation/i);
    });
  });

  describe("toTransformInput", () => {
    it("preserves an existing transform ID so an update replaces the grade", () => {
      const input = grade.toTransformInput(
        { ...grade.defaults, exposure: 1 },
        { transformId: "existing-grade" },
      );
      expect(input.id).toBe("existing-grade");
      expect(input.type).toBe("filter");
      expect(input.filterName).toBe("ColorGradeFilter");
      expect(input.parameters.exposure).toBe(1);
    });

    it("omits the ID when creating a new grade", () => {
      expect(grade.toTransformInput(grade.defaults).id).toBeUndefined();
    });

    it("validates the transform ID and authored model before writing", () => {
      expect(() =>
        grade.toTransformInput(grade.defaults, { transformId: "   " }),
      ).toThrow(/transform ID/i);
      expect(() =>
        grade.toTransformInput({
          ...grade.defaults,
          colorModel: { version: 1, gradingSpace: "future-wide-gamut" },
        } as never),
      ).toThrow(/unsupported color model/i);
    });

    it("round trips through a transform snapshot", () => {
      const input = grade.toTransformInput({ ...grade.defaults, saturation: 1.4 });
      const parsed = grade.parseTransform(
        gradeTransform(input.parameters, { filterName: input.filterName }),
      );
      expect(parsed?.saturation).toBe(1.4);
    });
  });

  it("evaluates a grade identically to the host reference pipeline", () => {
    const resolved = grade.normalize({ exposure: 0.5, saturation: 1.2, contrast: 1.1 });
    const host = createReferenceColorGradeEvaluator(resolved);
    const viaApi = extensionColorApi.createReferenceColorGradeEvaluator(resolved);
    const sample: readonly [number, number, number] = [0.2, 0.5, 0.8];
    expect(viaApi.apply(sample)).toEqual(host.apply(sample));
  });

  it("preserves renderer parity when creative LUT bytes are supplied", () => {
    const lut = extensionColorApi.parseCubeLut(`LUT_3D_SIZE 2
1 1 1
0 1 1
1 0 1
0 0 1
1 1 0
0 1 0
1 0 0
0 0 0
`);
    const resolved = grade.normalize({ lutIntensity: 0.75 });
    const host = createReferenceColorGradeEvaluator(resolved, { lut });
    const viaApi = extensionColorApi.createReferenceColorGradeEvaluator(resolved, {
      lut,
    });
    const sample: readonly [number, number, number] = [0.2, 0.5, 0.8];
    expect(viaApi.apply(sample)).toEqual(host.apply(sample));
  });

  it("is frozen so an extension cannot swap host color implementations", () => {
    expect(Object.isFrozen(extensionColorApi)).toBe(true);
    expect(Object.isFrozen(extensionColorApi.grade)).toBe(true);
  });
});
