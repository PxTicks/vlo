import { V1_COLOR_MODEL } from "./model";
import type { Rgb } from "./types";

export function rgbToHsv(color: Rgb): Rgb {
  const max = Math.max(...color);
  const min = Math.min(...color);
  const delta = max - min;
  let hue = 0;
  if (delta > Number.EPSILON) {
    if (max === color[0]) hue = ((color[1] - color[2]) / delta) % 6;
    else if (max === color[1]) hue = (color[2] - color[0]) / delta + 2;
    else hue = (color[0] - color[1]) / delta + 4;
    hue = ((hue / 6) % 1 + 1) % 1;
  }
  return [hue, max === 0 ? 0 : delta / max, max];
}

export function hsvToRgb(hsv: Rgb): Rgb {
  const hue = ((hsv[0] % 1) + 1) % 1;
  const sector = hue * 6;
  const chroma = hsv[2] * hsv[1];
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  let rgb: Rgb;
  if (sector < 1) rgb = [chroma, x, 0];
  else if (sector < 2) rgb = [x, chroma, 0];
  else if (sector < 3) rgb = [0, chroma, x];
  else if (sector < 4) rgb = [0, x, chroma];
  else if (sector < 5) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];
  const match = hsv[2] - chroma;
  return [rgb[0] + match, rgb[1] + match, rgb[2] + match];
}

export function applySaturationVibranceHue(
  color: Rgb,
  saturation: number,
  vibrance: number,
  hueRotateDegrees: number,
): Rgb {
  const coefficients = V1_COLOR_MODEL.working.lumaCoefficients;
  const luma =
    color[0] * coefficients[0] +
    color[1] * coefficients[1] +
    color[2] * coefficients[2];
  const currentSaturation = rgbToHsv(color)[1];
  const effectiveSaturation = Math.max(
    0,
    saturation + vibrance * (1 - currentSaturation),
  );
  const saturated = color.map(
    (channel) => luma + effectiveSaturation * (channel - luma),
  ) as unknown as Rgb;
  const hsv = rgbToHsv(saturated);
  return hsvToRgb([hsv[0] + hueRotateDegrees / 360, hsv[1], hsv[2]]);
}

export const GRADING_GLSL = `
vec3 vloRgbToHsv(vec3 color) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(color.bg, K.wz), vec4(color.gb, K.xy), step(color.b, color.g));
  vec4 q = mix(vec4(p.xyw, color.r), vec4(color.r, p.yzx), step(p.x, color.r));
  float delta = q.x - min(q.w, q.y);
  float epsilon = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * delta + epsilon)), delta / (q.x + epsilon), q.x);
}

vec3 vloHsvToRgb(vec3 hsv) {
  vec3 p = abs(fract(hsv.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return hsv.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), hsv.y);
}

vec3 vloApplySaturationVibranceHue(
  vec3 color,
  float saturation,
  float vibrance,
  float hueRotate
) {
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float currentSaturation = vloRgbToHsv(color).y;
  float effectiveSaturation = max(0.0, saturation + vibrance * (1.0 - currentSaturation));
  vec3 saturated = vec3(luma) + effectiveSaturation * (color - vec3(luma));
  vec3 hsv = vloRgbToHsv(saturated);
  hsv.x = fract(hsv.x + hueRotate);
  return vloHsvToRgb(hsv);
}
`;

