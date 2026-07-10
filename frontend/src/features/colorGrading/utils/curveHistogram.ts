export const CURVE_HISTOGRAM_BIN_COUNT = 128;

export type CurveHistogramKind = "luma" | "red" | "green" | "blue" | "hue";

export type CurveHistograms = Readonly<
  Record<CurveHistogramKind, Float32Array>
>;

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function binIndex(value: number): number {
  return Math.round(clampUnit(value) * (CURVE_HISTOGRAM_BIN_COUNT - 1));
}

function hueOf(r: number, g: number, b: number): number | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta <= 1 / 255) return null;
  let hue: number;
  if (max === r) {
    hue = ((g - b) / delta) % 6;
  } else if (max === g) {
    hue = (b - r) / delta + 2;
  } else {
    hue = (r - g) / delta + 4;
  }
  return ((hue / 6) % 1 + 1) % 1;
}

function normalizeHistogram(counts: Float32Array): Float32Array {
  let max = 0;
  for (const count of counts) max = Math.max(max, count);
  if (max === 0) return counts;
  const denominator = Math.log1p(max);
  for (let index = 0; index < counts.length; index += 1) {
    counts[index] = Math.log1p(counts[index]) / denominator;
  }
  return counts;
}

export function buildCurveHistograms(
  pixels: ArrayLike<number>,
): CurveHistograms {
  const red = new Float32Array(CURVE_HISTOGRAM_BIN_COUNT);
  const green = new Float32Array(CURVE_HISTOGRAM_BIN_COUNT);
  const blue = new Float32Array(CURVE_HISTOGRAM_BIN_COUNT);
  const luma = new Float32Array(CURVE_HISTOGRAM_BIN_COUNT);
  const hue = new Float32Array(CURVE_HISTOGRAM_BIN_COUNT);

  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = clampUnit(pixels[index + 3] / 255);
    if (alpha === 0) continue;
    const r = clampUnit(pixels[index] / 255 / alpha);
    const g = clampUnit(pixels[index + 1] / 255 / alpha);
    const b = clampUnit(pixels[index + 2] / 255 / alpha);
    red[binIndex(r)] += alpha;
    green[binIndex(g)] += alpha;
    blue[binIndex(b)] += alpha;
    luma[binIndex(0.2126 * r + 0.7152 * g + 0.0722 * b)] += alpha;
    const pixelHue = hueOf(r, g, b);
    if (pixelHue !== null) hue[binIndex(pixelHue)] += alpha;
  }

  return {
    luma: normalizeHistogram(luma),
    red: normalizeHistogram(red),
    green: normalizeHistogram(green),
    blue: normalizeHistogram(blue),
    hue: normalizeHistogram(hue),
  };
}

export function curveHistogramAreaPath(values: ArrayLike<number>): string {
  if (values.length === 0) return "";
  const points = Array.from({ length: values.length }, (_, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100;
    return `L ${x} ${(1 - clampUnit(values[index])) * 100}`;
  });
  return `M 0 100 ${points.join(" ")} L 100 100 Z`;
}
