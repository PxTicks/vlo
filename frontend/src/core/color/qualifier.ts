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

