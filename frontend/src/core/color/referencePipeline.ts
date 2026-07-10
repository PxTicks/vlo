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

export type ColorGradeReferenceParameters = ColorGradePrimaries & ColorCurveSet;

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

export function applyReferenceColorGrade(
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
  gradingColor = applyColorCurveLut(gradingColor, getCurveLut(parameters));
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
): Rgba {
  const alpha = premultipliedColor[3];
  if (alpha <= 1e-6) return [0, 0, 0, 0];
  const straight: Rgb = [
    premultipliedColor[0] / alpha,
    premultipliedColor[1] / alpha,
    premultipliedColor[2] / alpha,
  ];
  const graded = applyReferenceColorGrade(straight, parameters);
  return [graded[0] * alpha, graded[1] * alpha, graded[2] * alpha, alpha];
}
