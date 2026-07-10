import { hsvToRgb, rgbToHsv } from "./grading";
import type { Rgb } from "./types";

export interface ColorCurvePoint {
  readonly x: number;
  readonly y: number;
}

export const VALUE_CURVE_PARAMETER_NAMES = [
  "curveMaster",
  "curveR",
  "curveG",
  "curveB",
] as const;

export const MODIFIER_CURVE_PARAMETER_NAMES = [
  "curveHueHue",
  "curveHueSat",
  "curveLumaSat",
] as const;

export const CYCLIC_CURVE_PARAMETER_NAMES = [
  "curveHueHue",
  "curveHueSat",
] as const;

export type ValueCurveParameterName =
  (typeof VALUE_CURVE_PARAMETER_NAMES)[number];
export type ModifierCurveParameterName =
  (typeof MODIFIER_CURVE_PARAMETER_NAMES)[number];
export type ColorCurveParameterName =
  | ValueCurveParameterName
  | ModifierCurveParameterName;

const IDENTITY_CURVE = Object.freeze([
  Object.freeze({ x: 0, y: 0 }),
  Object.freeze({ x: 1, y: 1 }),
]);
const FLAT_MODIFIER_CURVE = Object.freeze([
  Object.freeze({ x: 0, y: 0 }),
  Object.freeze({ x: 0.5, y: 0 }),
]);

export const DEFAULT_COLOR_CURVES: Readonly<
  Record<ColorCurveParameterName, readonly ColorCurvePoint[]>
> = Object.freeze({
  curveMaster: IDENTITY_CURVE,
  curveR: IDENTITY_CURVE,
  curveG: IDENTITY_CURVE,
  curveB: IDENTITY_CURVE,
  curveHueHue: FLAT_MODIFIER_CURVE,
  curveHueSat: FLAT_MODIFIER_CURVE,
  curveLumaSat: FLAT_MODIFIER_CURVE,
});

export const COLOR_CURVE_LUT_WIDTH = 1024;
export const COLOR_CURVE_LUT_HEIGHT = 2;

export interface ColorCurveSet {
  readonly curveMaster?: readonly ColorCurvePoint[];
  readonly curveR?: readonly ColorCurvePoint[];
  readonly curveG?: readonly ColorCurvePoint[];
  readonly curveB?: readonly ColorCurvePoint[];
  readonly curveHueHue?: readonly ColorCurvePoint[];
  readonly curveHueSat?: readonly ColorCurvePoint[];
  readonly curveLumaSat?: readonly ColorCurvePoint[];
}

export interface ColorCurveSampler {
  at(value: number): number;
}

const POINT_EPSILON = 1e-6;

function wrapUnit(value: number): number {
  return ((value % 1) + 1) % 1;
}

function sanitizeSamplerPoints(
  points: readonly ColorCurvePoint[],
  cyclic: boolean,
): ColorCurvePoint[] {
  const sorted = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({
      x: cyclic ? wrapUnit(point.x) : point.x,
      y: point.y,
    }))
    .sort((left, right) => left.x - right.x);
  const unique: ColorCurvePoint[] = [];
  for (const point of sorted) {
    const previous = unique[unique.length - 1];
    if (previous && Math.abs(previous.x - point.x) <= POINT_EPSILON) {
      unique[unique.length - 1] = point;
    } else {
      unique.push(point);
    }
  }
  return unique;
}

function calculateMonotoneTangents(
  xs: readonly number[],
  ys: readonly number[],
): number[] {
  const count = xs.length;
  const tangents = new Array<number>(count).fill(0);
  if (count < 2) return tangents;
  const secants = Array.from(
    { length: count - 1 },
    (_, index) =>
      (ys[index + 1] - ys[index]) / (xs[index + 1] - xs[index]),
  );
  tangents[0] = secants[0];
  tangents[count - 1] = secants[count - 2];
  for (let index = 1; index < count - 1; index += 1) {
    tangents[index] = (secants[index - 1] + secants[index]) / 2;
  }
  for (let index = 0; index < count - 1; index += 1) {
    const secant = secants[index];
    if (Math.abs(secant) < 1e-9) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    if (index > 0 && secants[index - 1] * secant <= 0) {
      tangents[index] = 0;
    }
    const alpha = tangents[index] / secant;
    const beta = tangents[index + 1] / secant;
    const distance = Math.hypot(alpha, beta);
    if (distance > 3) {
      const scale = 3 / distance;
      tangents[index] = alpha * scale * secant;
      tangents[index + 1] = beta * scale * secant;
    }
  }
  return tangents;
}

export function createColorCurveSampler(
  points: readonly ColorCurvePoint[],
  cyclic = false,
): ColorCurveSampler {
  const sanitized = sanitizeSamplerPoints(points, cyclic);
  const expanded =
    cyclic && sanitized.length > 1
      ? [-1, 0, 1].flatMap((cycle) =>
          sanitized.map((point) => ({ x: point.x + cycle, y: point.y })),
        )
      : sanitized;
  const xs = expanded.map((point) => point.x);
  const ys = expanded.map((point) => point.y);
  const tangents = calculateMonotoneTangents(xs, ys);

  return {
    at(input: number): number {
      const value = cyclic ? wrapUnit(input) : input;
      if (xs.length === 0) return 0;
      if (xs.length === 1) return ys[0];
      if (value <= xs[0]) return ys[0];
      if (value >= xs[xs.length - 1]) return ys[ys.length - 1];

      let low = 0;
      let high = xs.length - 1;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (value >= xs[middle]) low = middle;
        else high = middle;
      }
      const width = xs[low + 1] - xs[low];
      const t = (value - xs[low]) / width;
      const t2 = t * t;
      const t3 = t2 * t;
      const result =
        (2 * t3 - 3 * t2 + 1) * ys[low] +
        (t3 - 2 * t2 + t) * width * tangents[low] +
        (-2 * t3 + 3 * t2) * ys[low + 1] +
        (t3 - t2) * width * tangents[low + 1];
      return Math.max(
        Math.min(ys[low], ys[low + 1]),
        Math.min(Math.max(ys[low], ys[low + 1]), result),
      );
    },
  };
}

function curvePoints(
  curves: ColorCurveSet,
  name: ColorCurveParameterName,
): readonly ColorCurvePoint[] {
  return curves[name] ?? DEFAULT_COLOR_CURVES[name];
}

export function bakeColorCurveLut(
  curves: ColorCurveSet,
  width = COLOR_CURVE_LUT_WIDTH,
): Float32Array {
  const pixels = new Float32Array(width * COLOR_CURVE_LUT_HEIGHT * 4);
  const valueSamplers = VALUE_CURVE_PARAMETER_NAMES.map((name) =>
    createColorCurveSampler(curvePoints(curves, name)),
  );
  const modifierSamplers = MODIFIER_CURVE_PARAMETER_NAMES.map((name) =>
    createColorCurveSampler(
      curvePoints(curves, name),
      (CYCLIC_CURVE_PARAMETER_NAMES as readonly string[]).includes(name),
    ),
  );
  for (let sample = 0; sample < width; sample += 1) {
    const x = sample / (width - 1);
    const valueOffset = sample * 4;
    const modifierOffset = (width + sample) * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      pixels[valueOffset + channel] = Math.max(
        0,
        Math.min(1, valueSamplers[channel].at(x)),
      );
      pixels[modifierOffset + channel] =
        channel < modifierSamplers.length
          ? Math.max(-0.5, Math.min(0.5, modifierSamplers[channel].at(x)))
          : 0;
    }
  }
  return pixels;
}

export function sampleColorCurveLut(
  pixels: Float32Array,
  row: 0 | 1,
  channel: 0 | 1 | 2 | 3,
  input: number,
  width = COLOR_CURVE_LUT_WIDTH,
): number {
  const scaled = Math.max(0, Math.min(1, input)) * (width - 1);
  const left = Math.floor(scaled);
  const right = Math.min(width - 1, left + 1);
  const amount = scaled - left;
  const leftValue = pixels[(row * width + left) * 4 + channel];
  const rightValue = pixels[(row * width + right) * 4 + channel];
  return leftValue + (rightValue - leftValue) * amount;
}

export function applyColorCurveLut(color: Rgb, pixels: Float32Array): Rgb {
  let curved: Rgb = [
    sampleColorCurveLut(pixels, 0, 0, color[0]),
    sampleColorCurveLut(pixels, 0, 0, color[1]),
    sampleColorCurveLut(pixels, 0, 0, color[2]),
  ];
  curved = [
    sampleColorCurveLut(pixels, 0, 1, curved[0]),
    sampleColorCurveLut(pixels, 0, 2, curved[1]),
    sampleColorCurveLut(pixels, 0, 3, curved[2]),
  ];
  const hsv = rgbToHsv(curved);
  const hue = hsv[0];
  const hueShift = sampleColorCurveLut(pixels, 1, 0, hue);
  const hueSaturation = sampleColorCurveLut(pixels, 1, 1, hue);
  const luma = curved[0] * 0.2126 + curved[1] * 0.7152 + curved[2] * 0.0722;
  const lumaSaturation = sampleColorCurveLut(pixels, 1, 2, luma);
  return hsvToRgb([
    wrapUnit(hue + hueShift),
    Math.max(
      0,
      Math.min(1, hsv[1] * Math.max(0, 1 + hueSaturation + lumaSaturation)),
    ),
    hsv[2],
  ]);
}
