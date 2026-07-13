import {
  DEFAULT_COLOR_CURVES,
  type ColorCurveParameterName,
  type ColorCurvePoint,
} from "./curves";
import { V1_AUTHORED_COLOR_MODEL, type AuthoredColorModelV1 } from "./model";
import {
  DEFAULT_COLOR_QUALIFIER,
  type ColorQualifierParameters,
} from "./qualifier";
import {
  DEFAULT_COLOR_GRADE_LUT,
  DEFAULT_COLOR_GRADE_PRIMARIES,
  type ColorGradeLutParameters,
  type ColorGradePrimaries,
} from "./referencePipeline";

/**
 * The V1 grade parameter schema, shared by the renderer and the extension API.
 *
 * The renderer's fused filter and `api.color.grade` must agree on defaults and
 * bounds exactly: a divergence here would let an extension compute a grade that
 * the GPU then evaluates differently. This module is the single owner of that
 * contract. Shader variant-key selection and texture packing remain renderer
 * concerns and stay in the colorGrade filter feature.
 */

/** Grade values ready for numeric evaluation. No animation objects remain. */
export interface ColorGradeResolvedParametersV1
  extends ColorGradePrimaries,
    ColorQualifierParameters,
    ColorGradeLutParameters {
  readonly colorModel: AuthoredColorModelV1;
  readonly ditherStrength: number;
  readonly curveMaster: readonly ColorCurvePoint[];
  readonly curveR: readonly ColorCurvePoint[];
  readonly curveG: readonly ColorCurvePoint[];
  readonly curveB: readonly ColorCurvePoint[];
  readonly curveHueHue: readonly ColorCurvePoint[];
  readonly curveHueSat: readonly ColorCurvePoint[];
  readonly curveLumaSat: readonly ColorCurvePoint[];
}

export type ColorGradeParameterName = Exclude<
  keyof ColorGradeResolvedParametersV1,
  "colorModel"
>;

export type ColorGradeParameterKind =
  | "number"
  | "boolean"
  | "curve"
  | "lut-asset-id";

export class ColorGradeSchemaError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ColorGradeSchemaError";
  }
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function curvePoints(
  name: ColorCurveParameterName,
  value: unknown,
): readonly ColorCurvePoint[] {
  if (!Array.isArray(value)) return DEFAULT_COLOR_CURVES[name];
  const points = value
    .filter(
      (point): point is ColorCurvePoint =>
        typeof point === "object" &&
        point !== null &&
        "x" in point &&
        "y" in point &&
        typeof point.x === "number" &&
        Number.isFinite(point.x) &&
        typeof point.y === "number" &&
        Number.isFinite(point.y),
    )
    .map((point) => ({
      x: clamp(point.x, 0, 1),
      y: point.y,
    }))
    .sort((left, right) => left.x - right.x);
  return points.length > 0 ? points : DEFAULT_COLOR_CURVES[name];
}

function scalar(
  fallback: number,
  low = Number.NEGATIVE_INFINITY,
  high = Number.POSITIVE_INFINITY,
): (value: unknown) => number {
  return (value) => clamp(finiteOr(value, fallback), low, high);
}

function flag(fallback: boolean): (value: unknown) => boolean {
  return (value) => booleanOr(value, fallback);
}

function curve(
  name: ColorCurveParameterName,
): (value: unknown) => readonly ColorCurvePoint[] {
  return (value) => curvePoints(name, value);
}

type GradeFieldNormalizers = {
  readonly [Name in ColorGradeParameterName]: (
    value: unknown,
  ) => ColorGradeResolvedParametersV1[Name];
};

/**
 * Per-field normalizers. Keeping them in one table is what lets a partial patch
 * clamp exactly the fields it carries without resetting the rest of the grade.
 */
const GRADE_FIELD_NORMALIZERS: GradeFieldNormalizers = {
  exposure: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.exposure),
  temperature: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.temperature),
  tint: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.tint),
  contrast: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.contrast, 0),
  pivot: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.pivot),
  kneeThreshold: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.kneeThreshold),
  kneeSoftness: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.kneeSoftness, 0),
  toeAmount: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.toeAmount, 0, 1),
  toeSoftness: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.toeSoftness, 0),
  saturation: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.saturation, 0),
  vibrance: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.vibrance, -1, 1),
  hueRotate: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.hueRotate),
  liftR: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.liftR),
  liftG: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.liftG),
  liftB: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.liftB),
  liftMaster: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.liftMaster),
  gammaR: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.gammaR),
  gammaG: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.gammaG),
  gammaB: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.gammaB),
  gammaMaster: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.gammaMaster),
  gainR: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.gainR),
  gainG: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.gainG),
  gainB: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.gainB),
  gainMaster: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.gainMaster),
  offsetR: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.offsetR),
  offsetG: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.offsetG),
  offsetB: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.offsetB),
  offsetMaster: scalar(DEFAULT_COLOR_GRADE_PRIMARIES.offsetMaster),
  curveMaster: curve("curveMaster"),
  curveR: curve("curveR"),
  curveG: curve("curveG"),
  curveB: curve("curveB"),
  curveHueHue: curve("curveHueHue"),
  curveHueSat: curve("curveHueSat"),
  curveLumaSat: curve("curveLumaSat"),
  qualifierEnabled: flag(DEFAULT_COLOR_QUALIFIER.qualifierEnabled),
  hueCenter: (value) => {
    const hue = finiteOr(value, DEFAULT_COLOR_QUALIFIER.hueCenter);
    return ((hue % 1) + 1) % 1;
  },
  hueWidth: scalar(DEFAULT_COLOR_QUALIFIER.hueWidth, 0, 1),
  hueSoftLo: scalar(DEFAULT_COLOR_QUALIFIER.hueSoftLo, 0, 0.5),
  hueSoftHi: scalar(DEFAULT_COLOR_QUALIFIER.hueSoftHi, 0, 0.5),
  satLo: scalar(DEFAULT_COLOR_QUALIFIER.satLo, 0, 1),
  satHi: scalar(DEFAULT_COLOR_QUALIFIER.satHi, 0, 1),
  satSoftLo: scalar(DEFAULT_COLOR_QUALIFIER.satSoftLo, 0, 1),
  satSoftHi: scalar(DEFAULT_COLOR_QUALIFIER.satSoftHi, 0, 1),
  lumaLo: scalar(DEFAULT_COLOR_QUALIFIER.lumaLo, 0, 1),
  lumaHi: scalar(DEFAULT_COLOR_QUALIFIER.lumaHi, 0, 1),
  lumaSoftLo: scalar(DEFAULT_COLOR_QUALIFIER.lumaSoftLo, 0, 1),
  lumaSoftHi: scalar(DEFAULT_COLOR_QUALIFIER.lumaSoftHi, 0, 1),
  qualifierInvert: flag(DEFAULT_COLOR_QUALIFIER.qualifierInvert),
  mattePreview: flag(DEFAULT_COLOR_QUALIFIER.mattePreview),
  lutAssetId: (value) =>
    typeof value === "string" && value.length > 0
      ? value
      : DEFAULT_COLOR_GRADE_LUT.lutAssetId,
  lutIntensity: scalar(DEFAULT_COLOR_GRADE_LUT.lutIntensity, 0, 1),
  ditherStrength: scalar(1, 0),
};

export const COLOR_GRADE_PARAMETER_NAMES = Object.freeze(
  Object.keys(GRADE_FIELD_NORMALIZERS) as ColorGradeParameterName[],
) as readonly ColorGradeParameterName[];

const GRADE_PARAMETER_NAME_SET: ReadonlySet<string> = new Set(
  COLOR_GRADE_PARAMETER_NAMES,
);

const CURVE_PARAMETER_NAMES: ReadonlySet<ColorGradeParameterName> = new Set([
  "curveMaster",
  "curveR",
  "curveG",
  "curveB",
  "curveHueHue",
  "curveHueSat",
  "curveLumaSat",
]);

const BOOLEAN_PARAMETER_NAMES: ReadonlySet<ColorGradeParameterName> = new Set([
  "qualifierEnabled",
  "qualifierInvert",
  "mattePreview",
]);

export function isColorGradeParameterName(
  name: string,
): name is ColorGradeParameterName {
  return GRADE_PARAMETER_NAME_SET.has(name);
}

export function getColorGradeParameterKind(
  name: ColorGradeParameterName,
): ColorGradeParameterKind {
  if (CURVE_PARAMETER_NAMES.has(name)) return "curve";
  if (BOOLEAN_PARAMETER_NAMES.has(name)) return "boolean";
  if (name === "lutAssetId") return "lut-asset-id";
  return "number";
}

export const DEFAULT_COLOR_GRADE_PARAMETERS: ColorGradeResolvedParametersV1 =
  Object.freeze(normalizeColorGradeParameters({}));

/**
 * Qualifier ranges are authored as an unordered pair. Swapping is only valid
 * when both ends are known, so a patch carrying one end must leave it alone.
 */
function orderRange<Low extends string, High extends string>(
  target: Record<string, unknown>,
  low: Low,
  high: High,
): void {
  const lowValue = target[low];
  const highValue = target[high];
  if (typeof lowValue !== "number" || typeof highValue !== "number") return;
  target[low] = Math.min(lowValue, highValue);
  target[high] = Math.max(lowValue, highValue);
}

/**
 * Fills defaults and clamps every field. The input must already be resolved:
 * an authored animation object is not a number and would silently normalize to
 * its default, erasing the animation. Callers holding persisted parameters must
 * resolve them at a source time first, or use `assertStaticColorGradeValues`.
 */
export function normalizeColorGradeParameters(
  source: Readonly<Record<string, unknown>>,
): ColorGradeResolvedParametersV1 {
  const target: Record<string, unknown> = { colorModel: V1_AUTHORED_COLOR_MODEL };
  for (const name of COLOR_GRADE_PARAMETER_NAMES) {
    target[name] = GRADE_FIELD_NORMALIZERS[name](source[name]);
  }
  orderRange(target, "satLo", "satHi");
  orderRange(target, "lumaLo", "lumaHi");
  return target as unknown as ColorGradeResolvedParametersV1;
}

/**
 * Clamps only the fields the patch actually carries. This renderer-side helper
 * intentionally ignores unknown keys because render normalization must remain
 * tolerant and non-throwing. Extension-facing callers validate their boundary
 * before reaching this function.
 */
export function normalizeColorGradeParameterPatch(
  patch: Readonly<Record<string, unknown>>,
): Partial<ColorGradeResolvedParametersV1> {
  const target: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(patch)) {
    if (!isColorGradeParameterName(name)) continue;
    target[name] = GRADE_FIELD_NORMALIZERS[name](value);
  }
  orderRange(target, "satLo", "satHi");
  orderRange(target, "lumaLo", "lumaHi");
  return target as Partial<ColorGradeResolvedParametersV1>;
}

/**
 * True for a value the host resolves per-frame rather than storing statically —
 * today an authored keyframe spline. Curves are point arrays, so excluding
 * arrays leaves splines as the only shape that qualifies.
 */
export function isAuthoredAnimationValue(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Guards the static normalizer against animated input. Static normalization of
 * a spline would replace it with a default and silently drop the animation, so
 * callers that may hold persisted parameters assert first and fail loudly.
 */
export function assertStaticColorGradeValues(
  source: Readonly<Record<string, unknown>>,
  options: Readonly<{ allowColorModel?: boolean }> = {},
): void {
  for (const [name, value] of Object.entries(source)) {
    if (name === "colorModel") {
      if (options.allowColorModel === false) {
        throw new ColorGradeSchemaError(
          "A grade parameter patch cannot change colorModel.",
        );
      }
      if (!isSupportedColorGradeModel(value)) {
        throw new ColorGradeSchemaError("Grade uses an unsupported color model.");
      }
      continue;
    }
    if (!isColorGradeParameterName(name)) {
      throw new ColorGradeSchemaError(
        `Unknown grade parameter '${name}'.`,
      );
    }
    const kind = getColorGradeParameterKind(name);
    if (kind === "number") {
      if (isAuthoredAnimationValue(value)) {
        throw new ColorGradeSchemaError(
          `Grade parameter '${name}' is animated. Resolve the grade at a source time before static normalization.`,
        );
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ColorGradeSchemaError(
          `Grade parameter '${name}' must be a finite number.`,
        );
      }
      continue;
    }
    if (kind === "boolean") {
      if (typeof value !== "boolean") {
        throw new ColorGradeSchemaError(
          `Grade parameter '${name}' must be a boolean.`,
        );
      }
      continue;
    }
    if (kind === "lut-asset-id") {
      if (value !== null && (typeof value !== "string" || value.length === 0)) {
        throw new ColorGradeSchemaError(
          "Grade parameter 'lutAssetId' must be null or a non-empty string.",
        );
      }
      continue;
    }
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some(
        (point) =>
          typeof point !== "object" ||
          point === null ||
          Array.isArray(point) ||
          Object.keys(point).some((key) => key !== "x" && key !== "y") ||
          !("x" in point) ||
          typeof point.x !== "number" ||
          !Number.isFinite(point.x) ||
          !("y" in point) ||
          typeof point.y !== "number" ||
          !Number.isFinite(point.y),
      )
    ) {
      throw new ColorGradeSchemaError(
        `Grade parameter '${name}' must contain finite curve points.`,
      );
    }
  }
}

/** V1 grades are the only model this schema can interpret; anything else fails closed. */
export function isSupportedColorGradeModel(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    (value as { version?: unknown }).version === V1_AUTHORED_COLOR_MODEL.version &&
    (value as { gradingSpace?: unknown }).gradingSpace ===
      V1_AUTHORED_COLOR_MODEL.gradingSpace
  );
}
