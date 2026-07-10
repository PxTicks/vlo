import { applySaturationVibranceHue } from "./grading";
import { applyMatrix3, whiteBalanceMatrix } from "./matrices";
import { linearToSrgb, srgbToLinear } from "./transfer";
import { applyToneCurve } from "./toneCurve";
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
});

export function applyReferenceColorGrade(
  encodedColor: Rgb,
  parameters: ColorGradePrimaries = DEFAULT_COLOR_GRADE_PRIMARIES,
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
  gradingColor = applyToneCurve(gradingColor, parameters);
  return applySaturationVibranceHue(
    gradingColor,
    parameters.saturation,
    parameters.vibrance,
    parameters.hueRotate,
  );
}

export function applyReferenceColorGradePixel(
  premultipliedColor: Rgba,
  parameters: ColorGradePrimaries = DEFAULT_COLOR_GRADE_PRIMARIES,
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

