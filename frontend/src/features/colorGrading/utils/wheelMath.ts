import { hsvToRgb, rgbToHsv, type Rgb } from "../../../core/color";

export interface WheelAdjustment {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly master: number;
}

export function wheelPointToAdjustment(
  x: number,
  y: number,
  radius: number,
  maxChroma: number,
  fine = false,
): Pick<WheelAdjustment, "r" | "g" | "b"> {
  const distance = Math.min(1, Math.hypot(x, y) / radius);
  if (distance <= Number.EPSILON) return { r: 0, g: 0, b: 0 };
  const hue = ((Math.atan2(y, x) / (Math.PI * 2)) + 1) % 1;
  const rgb = hsvToRgb([hue, 1, 1]);
  const average = (rgb[0] + rgb[1] + rgb[2]) / 3;
  const scale = distance * maxChroma * (fine ? 0.2 : 1);
  return {
    r: (rgb[0] - average) * scale,
    g: (rgb[1] - average) * scale,
    b: (rgb[2] - average) * scale,
  };
}

export function adjustmentToWheelPoint(
  adjustment: Pick<WheelAdjustment, "r" | "g" | "b">,
  radius: number,
  maxChroma: number,
): { x: number; y: number } {
  const values: Rgb = [adjustment.r, adjustment.g, adjustment.b];
  const minimum = Math.min(...values);
  const shifted: Rgb = [
    values[0] - minimum,
    values[1] - minimum,
    values[2] - minimum,
  ];
  const hsv = rgbToHsv(shifted);
  const basis = hsvToRgb([hsv[0], 1, 1]);
  const basisAverage = (basis[0] + basis[1] + basis[2]) / 3;
  const direction: Rgb = [
    basis[0] - basisAverage,
    basis[1] - basisAverage,
    basis[2] - basisAverage,
  ];
  const denominator =
    direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2;
  const recoveredScale =
    denominator <= Number.EPSILON
      ? 0
      : (values[0] * direction[0] +
          values[1] * direction[1] +
          values[2] * direction[2]) /
        denominator;
  const magnitude = Math.min(
    1,
    Math.abs(recoveredScale) / Math.max(maxChroma, Number.EPSILON),
  );
  const angle = hsv[0] * Math.PI * 2;
  return {
    x: Math.cos(angle) * magnitude * radius,
    y: Math.sin(angle) * magnitude * radius,
  };
}
