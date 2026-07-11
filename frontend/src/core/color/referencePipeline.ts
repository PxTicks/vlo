import { applySaturationVibranceHue } from "./grading";
import { applyLiftGammaGainOffset } from "./cdl";
import { applyMatrix3, whiteBalanceMatrix } from "./matrices";
import { linearToSrgb, srgbToLinear } from "./transfer";
import { applyToneCurve } from "./toneCurve";
import {
  applyColorCurveLut,
  bakeColorCurveLut,
  MODIFIER_CURVE_PARAMETER_NAMES,
  VALUE_CURVE_PARAMETER_NAMES,
  type ColorCurveSet,
} from "./curves";
import type { Rgb, Rgba } from "./types";
import {
  colorQualifierWeight,
  DEFAULT_COLOR_QUALIFIER,
  type ColorQualifierParameters,
} from "./qualifier";
import { sampleCubeLut, type CubeLut } from "./cube";

export interface ColorGradePrimaries {
  readonly exposure: number;
  readonly temperature: number;
  readonly tint: number;
  readonly contrast: number;
  readonly pivot: number;
  readonly kneeThreshold: number;
  readonly kneeSoftness: number;
  readonly toeAmount: number;
  readonly toeSoftness: number;
  readonly saturation: number;
  readonly vibrance: number;
  readonly hueRotate: number;
  readonly liftR: number;
  readonly liftG: number;
  readonly liftB: number;
  readonly liftMaster: number;
  readonly gammaR: number;
  readonly gammaG: number;
  readonly gammaB: number;
  readonly gammaMaster: number;
  readonly gainR: number;
  readonly gainG: number;
  readonly gainB: number;
  readonly gainMaster: number;
  readonly offsetR: number;
  readonly offsetG: number;
  readonly offsetB: number;
  readonly offsetMaster: number;
}

export const DEFAULT_COLOR_GRADE_PRIMARIES: ColorGradePrimaries = Object.freeze({
  exposure: 0,
  temperature: 0,
  tint: 0,
  contrast: 1,
  pivot: 0.435,
  kneeThreshold: 1,
  kneeSoftness: 0,
  toeAmount: 0,
  toeSoftness: 0,
  saturation: 1,
  vibrance: 0,
  hueRotate: 0,
  liftR: 0,
  liftG: 0,
  liftB: 0,
  liftMaster: 0,
  gammaR: 0,
  gammaG: 0,
  gammaB: 0,
  gammaMaster: 0,
  gainR: 0,
  gainG: 0,
  gainB: 0,
  gainMaster: 0,
  offsetR: 0,
  offsetG: 0,
  offsetB: 0,
  offsetMaster: 0,
});

/** Creative-LUT slot on a grade; the `.cube` payload lives in a user asset. */
export interface ColorGradeLutParameters {
  readonly lutAssetId: string | null;
  readonly lutIntensity: number;
}

export const DEFAULT_COLOR_GRADE_LUT: ColorGradeLutParameters = Object.freeze({
  lutAssetId: null,
  lutIntensity: 1,
});

export type ColorGradeReferenceParameters = ColorGradePrimaries &
  ColorCurveSet &
  Partial<ColorQualifierParameters> &
  Partial<ColorGradeLutParameters>;

/** Out-of-band inputs the parameter JSON only references (LUT asset data). */
export interface ColorGradeReferenceOptions {
  readonly lut?: CubeLut | null;
}

export interface ColorGradeReferenceEvaluator {
  beforeCurves(color: Rgb): Rgb;
  curves(color: Rgb): Rgb;
  afterCurves(color: Rgb): Rgb;
  composite(input: Rgb, graded: Rgb): Rgb;
  lut(color: Rgb): Rgb;
  apply(color: Rgb): Rgb;
}

const curveLutCache = new Map<string, Float32Array>();
const MAX_CURVE_LUT_CACHE_ENTRIES = 16;

function getCurveLut(parameters: ColorCurveSet): Float32Array {
  const names = [
    ...VALUE_CURVE_PARAMETER_NAMES,
    ...MODIFIER_CURVE_PARAMETER_NAMES,
  ];
  const key = names
    .map((name) =>
      (parameters[name] ?? [])
        .map((point) => `${point.x.toFixed(6)}:${point.y.toFixed(6)}`)
        .join("|"),
    )
    .join(";");
  const cached = curveLutCache.get(key);
  if (cached) return cached;
  const lut = bakeColorCurveLut(parameters);
  curveLutCache.set(key, lut);
  if (curveLutCache.size > MAX_CURVE_LUT_CACHE_ENTRIES) {
    const oldest = curveLutCache.keys().next().value;
    if (oldest !== undefined) curveLutCache.delete(oldest);
  }
  return lut;
}

export function createReferenceColorGradeEvaluator(
  parameters: ColorGradeReferenceParameters = DEFAULT_COLOR_GRADE_PRIMARIES,
  options: ColorGradeReferenceOptions = {},
): ColorGradeReferenceEvaluator {
  const whiteBalance = whiteBalanceMatrix(
    parameters.temperature,
    parameters.tint,
  );
  const exposureMultiplier = Math.pow(2, parameters.exposure);
  const curveLut = getCurveLut(parameters);
  const wheelParameters = {
    lift: [parameters.liftR, parameters.liftG, parameters.liftB] as Rgb,
    liftMaster: parameters.liftMaster,
    gamma: [parameters.gammaR, parameters.gammaG, parameters.gammaB] as Rgb,
    gammaMaster: parameters.gammaMaster,
    gain: [parameters.gainR, parameters.gainG, parameters.gainB] as Rgb,
    gainMaster: parameters.gainMaster,
    offset: [parameters.offsetR, parameters.offsetG, parameters.offsetB] as Rgb,
    offsetMaster: parameters.offsetMaster,
  };

  const beforeCurves = (encodedColor: Rgb): Rgb => {
    let linear = applyMatrix3(whiteBalance, srgbToLinear(encodedColor));
    linear = linear.map(
      (channel) => channel * exposureMultiplier,
    ) as unknown as Rgb;
    let gradingColor = linearToSrgb(linear);
    gradingColor = applyLiftGammaGainOffset(gradingColor, wheelParameters);
    return applyToneCurve(gradingColor, parameters);
  };
  const curves = (color: Rgb): Rgb => applyColorCurveLut(color, curveLut);
  const afterCurves = (color: Rgb): Rgb =>
    applySaturationVibranceHue(
      color,
      parameters.saturation,
      parameters.vibrance,
      parameters.hueRotate,
    );
  const qualifierParameters: ColorQualifierParameters = {
    ...DEFAULT_COLOR_QUALIFIER,
    ...parameters,
  };
  const composite = (input: Rgb, graded: Rgb): Rgb => {
    const weight = colorQualifierWeight(input, qualifierParameters);
    if (
      qualifierParameters.qualifierEnabled &&
      qualifierParameters.mattePreview
    ) {
      return [weight, weight, weight];
    }
    return [
      input[0] + (graded[0] - input[0]) * weight,
      input[1] + (graded[1] - input[1]) * weight,
      input[2] + (graded[2] - input[2]) * weight,
    ];
  };

  // Per the pipeline order (§2.3), the creative LUT applies after the
  // qualifier has mixed the graded result back over its input.
  const lutData = options.lut ?? null;
  const lutIntensity = Math.max(0, Math.min(1, parameters.lutIntensity ?? 1));
  const matteBypassesLut =
    qualifierParameters.qualifierEnabled && qualifierParameters.mattePreview;
  const lut = (color: Rgb): Rgb => {
    if (!lutData || lutIntensity <= 0 || matteBypassesLut) return color;
    const mapped = sampleCubeLut(lutData, color);
    return [
      color[0] + (mapped[0] - color[0]) * lutIntensity,
      color[1] + (mapped[1] - color[1]) * lutIntensity,
      color[2] + (mapped[2] - color[2]) * lutIntensity,
    ];
  };

  return {
    beforeCurves,
    curves,
    afterCurves,
    composite,
    lut,
    apply(color) {
      return lut(composite(color, afterCurves(curves(beforeCurves(color)))));
    },
  };
}

export function applyReferenceColorGrade(
  encodedColor: Rgb,
  parameters: ColorGradeReferenceParameters = DEFAULT_COLOR_GRADE_PRIMARIES,
  options: ColorGradeReferenceOptions = {},
): Rgb {
  return createReferenceColorGradeEvaluator(parameters, options).apply(
    encodedColor,
  );
}

export function applyReferenceColorGradeBeforeCurves(
  encodedColor: Rgb,
  parameters: ColorGradeReferenceParameters = DEFAULT_COLOR_GRADE_PRIMARIES,
): Rgb {
  let linear = srgbToLinear(encodedColor);
  linear = applyMatrix3(
    whiteBalanceMatrix(parameters.temperature, parameters.tint),
    linear,
  );
  const exposureMultiplier = Math.pow(2, parameters.exposure);
  linear = linear.map(
    (channel) => channel * exposureMultiplier,
  ) as unknown as Rgb;

  let gradingColor = linearToSrgb(linear);
  gradingColor = applyLiftGammaGainOffset(gradingColor, {
    lift: [parameters.liftR, parameters.liftG, parameters.liftB],
    liftMaster: parameters.liftMaster,
    gamma: [parameters.gammaR, parameters.gammaG, parameters.gammaB],
    gammaMaster: parameters.gammaMaster,
    gain: [parameters.gainR, parameters.gainG, parameters.gainB],
    gainMaster: parameters.gainMaster,
    offset: [parameters.offsetR, parameters.offsetG, parameters.offsetB],
    offsetMaster: parameters.offsetMaster,
  });
  gradingColor = applyToneCurve(gradingColor, parameters);
  return gradingColor;
}

export function applyReferenceColorGradeCurves(
  gradingColor: Rgb,
  parameters: ColorGradeReferenceParameters = DEFAULT_COLOR_GRADE_PRIMARIES,
): Rgb {
  return applyColorCurveLut(gradingColor, getCurveLut(parameters));
}

export function applyReferenceColorGradeAfterCurves(
  gradingColor: Rgb,
  parameters: ColorGradeReferenceParameters = DEFAULT_COLOR_GRADE_PRIMARIES,
): Rgb {
  return applySaturationVibranceHue(
    gradingColor,
    parameters.saturation,
    parameters.vibrance,
    parameters.hueRotate,
  );
}

export function applyReferenceColorGradePixel(
  premultipliedColor: Rgba,
  parameters: ColorGradeReferenceParameters = DEFAULT_COLOR_GRADE_PRIMARIES,
  options: ColorGradeReferenceOptions = {},
): Rgba {
  const alpha = premultipliedColor[3];
  if (alpha <= 1e-6) return [0, 0, 0, 0];
  const straight: Rgb = [
    premultipliedColor[0] / alpha,
    premultipliedColor[1] / alpha,
    premultipliedColor[2] / alpha,
  ];
  const graded = applyReferenceColorGrade(straight, parameters, options);
  return [graded[0] * alpha, graded[1] * alpha, graded[2] * alpha, alpha];
}

export const COLOR_GRADE_CUBE_EXPORT_SIZE = 33;

/**
 * Bakes the full grade (including qualifier compositing and any creative LUT,
 * both pure color→color maps) into a 3D LUT over the grading-space unit cube.
 * Matte preview is a debug view and is excluded; outputs are clamped to [0,1]
 * to match the renderer's final encode.
 */
export function bakeColorGradeCube(
  parameters: ColorGradeReferenceParameters,
  options: {
    readonly size?: number;
    readonly title?: string | null;
    readonly lut?: CubeLut | null;
  } = {},
): CubeLut {
  const size = options.size ?? COLOR_GRADE_CUBE_EXPORT_SIZE;
  const evaluator = createReferenceColorGradeEvaluator(
    { ...parameters, mattePreview: false },
    { lut: options.lut },
  );
  const data = new Float32Array(size * size * size * 3);
  let offset = 0;
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const graded = evaluator.apply([
          r / (size - 1),
          g / (size - 1),
          b / (size - 1),
        ]);
        data[offset] = Math.max(0, Math.min(1, graded[0]));
        data[offset + 1] = Math.max(0, Math.min(1, graded[1]));
        data[offset + 2] = Math.max(0, Math.min(1, graded[2]));
        offset += 3;
      }
    }
  }
  return {
    title: options.title ?? null,
    dimensions: 3,
    size,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    data,
  };
}
