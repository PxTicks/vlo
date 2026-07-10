import type { Rgb } from "./types";

function smoothHermite(
  value: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  slope0: number,
  slope1: number,
): number {
  const width = x1 - x0;
  const t = Math.max(0, Math.min(1, (value - x0) / width));
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * y0 +
    (t3 - 2 * t2 + t) * width * slope0 +
    (-2 * t3 + 3 * t2) * y1 +
    (t3 - t2) * width * slope1
  );
}

export function applyHighlightKnee(
  value: number,
  threshold: number,
  softness: number,
): number {
  if (softness <= 0 || value <= threshold - softness) return value;
  const start = threshold - softness;
  const end = threshold + softness;
  if (value >= end) return threshold;
  return smoothHermite(value, start, end, start, threshold, 1, 0);
}

export function applyShadowToe(
  value: number,
  amount: number,
  softness: number,
): number {
  if (amount <= 0 || softness <= 0 || value >= softness) return value;
  if (value <= 0) return softness * 0.25 * amount;
  const toe = smoothHermite(value, 0, softness, softness * 0.25, softness, 0, 1);
  return value + Math.max(0, Math.min(1, amount)) * (toe - value);
}

export interface ToneCurveParameters {
  readonly contrast: number;
  readonly pivot: number;
  readonly kneeThreshold: number;
  readonly kneeSoftness: number;
  readonly toeAmount: number;
  readonly toeSoftness: number;
}

export function applyToneCurve(
  color: Rgb,
  parameters: ToneCurveParameters,
): Rgb {
  return color.map((value) => {
    const contrasted =
      (value - parameters.pivot) * parameters.contrast + parameters.pivot;
    const withToe = applyShadowToe(
      contrasted,
      parameters.toeAmount,
      parameters.toeSoftness,
    );
    return applyHighlightKnee(
      withToe,
      parameters.kneeThreshold,
      parameters.kneeSoftness,
    );
  }) as unknown as Rgb;
}

export const TONE_CURVE_GLSL = `
float vloHermiteShoulder(
  float value,
  float x0,
  float x1,
  float y0,
  float y1,
  float slope0,
  float slope1
) {
  float width = x1 - x0;
  float t = clamp((value - x0) / width, 0.0, 1.0);
  float t2 = t * t;
  float t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * y0
    + (t3 - 2.0 * t2 + t) * width * slope0
    + (-2.0 * t3 + 3.0 * t2) * y1
    + (t3 - t2) * width * slope1;
}

float vloApplyToe(float value, float amount, float softness) {
  if (amount <= 0.0 || softness <= 0.0 || value >= softness) return value;
  if (value <= 0.0) return softness * 0.25 * amount;
  float toe = vloHermiteShoulder(value, 0.0, softness, softness * 0.25, softness, 0.0, 1.0);
  return mix(value, toe, clamp(amount, 0.0, 1.0));
}

float vloApplyKnee(float value, float threshold, float softness) {
  if (softness <= 0.0 || value <= threshold - softness) return value;
  float start = threshold - softness;
  float end = threshold + softness;
  if (value >= end) return threshold;
  return vloHermiteShoulder(value, start, end, start, threshold, 1.0, 0.0);
}

vec3 vloApplyToneCurve(
  vec3 color,
  float contrast,
  float pivot,
  float kneeThreshold,
  float kneeSoftness,
  float toeAmount,
  float toeSoftness
) {
  vec3 result = (color - vec3(pivot)) * contrast + vec3(pivot);
  result = vec3(
    vloApplyToe(result.r, toeAmount, toeSoftness),
    vloApplyToe(result.g, toeAmount, toeSoftness),
    vloApplyToe(result.b, toeAmount, toeSoftness)
  );
  return vec3(
    vloApplyKnee(result.r, kneeThreshold, kneeSoftness),
    vloApplyKnee(result.g, kneeThreshold, kneeSoftness),
    vloApplyKnee(result.b, kneeThreshold, kneeSoftness)
  );
}
`;

