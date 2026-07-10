import type { Rgb } from "./types";

export function srgbChannelToLinear(value: number): number {
  return value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
}

export function linearChannelToSrgb(value: number): number {
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

export function srgbToLinear(color: Rgb): Rgb {
  return color.map(srgbChannelToLinear) as unknown as Rgb;
}

export function linearToSrgb(color: Rgb): Rgb {
  return color.map(linearChannelToSrgb) as unknown as Rgb;
}

export const SRGB_TRANSFER_GLSL = `
float vloSrgbChannelToLinear(float value) {
  return value <= 0.04045
    ? value / 12.92
    : pow((value + 0.055) / 1.055, 2.4);
}

float vloLinearChannelToSrgb(float value) {
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * pow(value, 1.0 / 2.4) - 0.055;
}

vec3 vloSrgbToLinear(vec3 color) {
  return vec3(
    vloSrgbChannelToLinear(color.r),
    vloSrgbChannelToLinear(color.g),
    vloSrgbChannelToLinear(color.b)
  );
}

vec3 vloLinearToSrgb(vec3 color) {
  return vec3(
    vloLinearChannelToSrgb(color.r),
    vloLinearChannelToSrgb(color.g),
    vloLinearChannelToSrgb(color.b)
  );
}
`;
