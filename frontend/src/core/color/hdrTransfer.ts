import type { Rgb } from "./types";

const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;
const HLG_A = 0.17883277;
const HLG_B = 1 - 4 * HLG_A;
const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);

export function pqEotf(value: number): number {
  const encoded = Math.max(0, value);
  const power = Math.pow(encoded, 1 / PQ_M2);
  return Math.pow(
    Math.max(power - PQ_C1, 0) / Math.max(PQ_C2 - PQ_C3 * power, 1e-12),
    1 / PQ_M1,
  );
}

export function pqOetf(value: number): number {
  const power = Math.pow(Math.max(0, value), PQ_M1);
  return Math.pow((PQ_C1 + PQ_C2 * power) / (1 + PQ_C3 * power), PQ_M2);
}

export function hlgEotf(value: number): number {
  const encoded = Math.max(0, value);
  return encoded <= 0.5
    ? (encoded * encoded) / 3
    : (Math.exp((encoded - HLG_C) / HLG_A) + HLG_B) / 12;
}

export function hlgOetf(value: number): number {
  const linear = Math.max(0, value);
  return linear <= 1 / 12
    ? Math.sqrt(3 * linear)
    : HLG_A * Math.log(12 * linear - HLG_B) + HLG_C;
}

export function mapHdrTransfer(color: Rgb, transfer: "pq" | "hlg"): Rgb {
  const fn = transfer === "pq" ? pqEotf : hlgEotf;
  return [fn(color[0]), fn(color[1]), fn(color[2])];
}

export const HDR_TRANSFER_GLSL = `
float vloPqEotf(float value) {
  const float m1 = 2610.0 / 16384.0;
  const float m2 = (2523.0 / 4096.0) * 128.0;
  const float c1 = 3424.0 / 4096.0;
  const float c2 = (2413.0 / 4096.0) * 32.0;
  const float c3 = (2392.0 / 4096.0) * 32.0;
  float power = pow(max(value, 0.0), 1.0 / m2);
  return pow(max(power - c1, 0.0) / max(c2 - c3 * power, 1.0e-12), 1.0 / m1);
}

float vloHlgEotf(float value) {
  const float a = 0.17883277;
  const float b = 1.0 - 4.0 * a;
  const float c = 0.5 - a * log(4.0 * a);
  float encoded = max(value, 0.0);
  return encoded <= 0.5
    ? encoded * encoded / 3.0
    : (exp((encoded - c) / a) + b) / 12.0;
}
`;
