import {
  COLOR_HISTOGRAM_BIN_COUNT,
  buildColorHistograms,
  type ColorHistogramKind,
  type ColorHistograms,
} from "../../../core/color";

export const CURVE_HISTOGRAM_BIN_COUNT = COLOR_HISTOGRAM_BIN_COUNT;
export type CurveHistogramKind = ColorHistogramKind;
export type CurveHistograms = ColorHistograms;
export const buildCurveHistograms = buildColorHistograms;

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function curveHistogramAreaPath(values: ArrayLike<number>): string {
  if (values.length === 0) return "";
  const points = Array.from({ length: values.length }, (_, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100;
    return `L ${x} ${(1 - clampUnit(values[index])) * 100}`;
  });
  return `M 0 100 ${points.join(" ")} L 100 100 Z`;
}

export function curveHistogramLinePath(values: ArrayLike<number>): string {
  if (values.length === 0) return "";
  return Array.from({ length: values.length }, (_, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100;
    return `${index === 0 ? "M" : "L"} ${x} ${
      (1 - clampUnit(values[index])) * 100
    }`;
  }).join(" ");
}
