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
  const magnitude = Math.min(
    1,
    Math.max(Math.abs(adjustment.r), Math.abs(adjustment.g), Math.abs(adjustment.b)) /
      Math.max(maxChroma * (2 / 3), Number.EPSILON),
  );
  const angle = hsv[0] * Math.PI * 2;
  return {
    x: Math.cos(angle) * magnitude * radius,
    y: Math.sin(angle) * magnitude * radius,
  };
}
