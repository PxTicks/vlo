import { rgbToHsv } from "./grading";
import type { Rgb } from "./types";

export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function softTrapezoidWeight(
  value: number,
  low: number,
  high: number,
  softLow: number,
  softHigh: number,
): number {
  const lowWeight =
    softLow <= 0 ? (value >= low ? 1 : 0) : smoothstep(low - softLow, low, value);
  const highWeight =
    softHigh <= 0 ? (value <= high ? 1 : 0) : 1 - smoothstep(high, high + softHigh, value);
  return lowWeight * highWeight;
}

export function circularHueWeight(
  hue: number,
  center: number,
  width: number,
  softLow: number,
  softHigh: number,
): number {
  const wrappedDistance = ((hue - center + 1.5) % 1) - 0.5;
  return softTrapezoidWeight(
    wrappedDistance,
    -width / 2,
    width / 2,
    softLow,
    softHigh,
  );
}

export function colorQualifierWeight(
  color: Rgb,
  parameters: ColorQualifierParameters,
): number {
  if (!parameters.qualifierEnabled) return 1;
  const hsv = rgbToHsv(color);
  const hue = circularHueWeight(
    hsv[0],
    parameters.hueCenter,
    parameters.hueWidth,
    parameters.hueSoftLo,
    parameters.hueSoftHi,
  );
  const saturation = softTrapezoidWeight(
    hsv[1],
    parameters.satLo,
    parameters.satHi,
    parameters.satSoftLo,
    parameters.satSoftHi,
  );
  const luma = softTrapezoidWeight(
    color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722,
    parameters.lumaLo,
    parameters.lumaHi,
    parameters.lumaSoftLo,
    parameters.lumaSoftHi,
  );
  const weight = hue * saturation * luma;
  return parameters.qualifierInvert ? 1 - weight : weight;
}

export const QUALIFIER_GLSL = `
float vloSoftTrapezoid(
  float value,
  float low,
  float high,
  float softLow,
  float softHigh
) {
  float lowWeight = softLow <= 0.0
    ? step(low, value)
    : smoothstep(low - softLow, low, value);
  float highWeight = softHigh <= 0.0
    ? 1.0 - step(high, value) + float(value == high)
    : 1.0 - smoothstep(high, high + softHigh, value);
  return lowWeight * highWeight;
}

float vloCircularHueWeight(
  float hue,
  float center,
  float width,
  float softLow,
  float softHigh
) {
  float distance = mod(hue - center + 1.5, 1.0) - 0.5;
  return vloSoftTrapezoid(distance, -width * 0.5, width * 0.5, softLow, softHigh);
}
`;
export interface ColorQualifierParameters {
  readonly qualifierEnabled: boolean;
  readonly hueCenter: number;
  readonly hueWidth: number;
  readonly hueSoftLo: number;
  readonly hueSoftHi: number;
  readonly satLo: number;
  readonly satHi: number;
  readonly satSoftLo: number;
  readonly satSoftHi: number;
  readonly lumaLo: number;
  readonly lumaHi: number;
  readonly lumaSoftLo: number;
  readonly lumaSoftHi: number;
  readonly qualifierInvert: boolean;
  readonly mattePreview: boolean;
}

export const DEFAULT_COLOR_QUALIFIER: ColorQualifierParameters = Object.freeze({
  qualifierEnabled: false,
  hueCenter: 0,
  hueWidth: 1,
  hueSoftLo: 0,
  hueSoftHi: 0,
  satLo: 0,
  satHi: 1,
  satSoftLo: 0,
  satSoftHi: 0,
  lumaLo: 0,
  lumaHi: 1,
  lumaSoftLo: 0,
  lumaSoftHi: 0,
  qualifierInvert: false,
  mattePreview: false,
});
