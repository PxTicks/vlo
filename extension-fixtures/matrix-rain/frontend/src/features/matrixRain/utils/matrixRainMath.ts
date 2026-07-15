/**
 * Deterministic CPU reference for the Matrix Rain appearance. Every function
 * here mirrors the GLSL/WGSL fragment programs exactly, so the shader can be
 * unit-tested on the CPU (hashing, glyph selection, trail/head profile, palette)
 * and authors can reason about the algorithm without a GPU.
 *
 * All randomness derives only from integer cell coordinates, an explicit seed,
 * and quantized visual time — never `Math.random()` — which is what makes the
 * effect stable under repeated renders and identical across preview and export.
 */

export const GLYPH_COUNT = 16;
export const GLYPH_SIZE = 5;

/**
 * Sixteen original 5×5 "cyber glyph" bitmasks. Row 0 is the top of the cell;
 * bit index is `row * 5 + col` with col 0 on the left. Encoded once from a
 * readable layout and shared with both shader programs so the CPU reference and
 * the GPU can never drift.
 */
const GLYPH_ROWS: readonly string[][] = [
  ["01110", "10001", "10101", "10001", "01110"],
  ["00100", "01110", "10101", "00100", "00100"],
  ["10001", "01010", "00100", "01010", "10001"],
  ["11111", "00100", "00100", "00100", "11111"],
  ["10000", "11000", "10100", "00010", "00001"],
  ["01010", "01010", "11111", "01010", "01010"],
  ["11100", "10010", "11100", "10010", "11100"],
  ["00100", "00100", "11111", "00100", "00100"],
  ["10001", "10001", "11111", "10001", "10001"],
  ["01110", "10000", "01110", "00001", "01110"],
  ["11111", "00001", "00110", "01000", "11111"],
  ["10101", "01010", "10101", "01010", "10101"],
  ["00001", "00010", "00100", "01000", "10000"],
  ["11011", "11011", "00000", "11011", "11011"],
  ["01110", "10001", "10001", "10001", "01110"],
  ["10001", "11011", "10101", "11011", "10001"],
];

function encodeGlyph(rows: readonly string[]): number {
  let mask = 0;
  for (let row = 0; row < GLYPH_SIZE; row += 1) {
    for (let col = 0; col < GLYPH_SIZE; col += 1) {
      if (rows[row][col] === "1") {
        mask |= 1 << (row * GLYPH_SIZE + col);
      }
    }
  }
  return mask >>> 0;
}

/** The 16 glyph bitmasks as unsigned 25-bit integers, shared with the shaders. */
export const GLYPH_BITMASKS: readonly number[] = GLYPH_ROWS.map(encodeGlyph);

/** True when pixel (col, row) of glyph `glyphIndex` is lit. */
export function glyphBit(
  glyphIndex: number,
  col: number,
  row: number,
): boolean {
  const mask = GLYPH_BITMASKS[glyphIndex % GLYPH_COUNT];
  return ((mask >>> (row * GLYPH_SIZE + col)) & 1) === 1;
}

/**
 * 32-bit PCG-style integer hash. Uses `Math.imul` for wrapping 32-bit multiply
 * so it matches GLSL `uint` / WGSL `u32` overflow semantics exactly.
 */
export function pcgHash(value: number): number {
  let state = (Math.imul(value >>> 0, 747796405) + 2891336453) >>> 0;
  state = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return ((state >>> 22) ^ state) >>> 0;
}

export function hash2(a: number, b: number): number {
  return pcgHash((a ^ pcgHash(b >>> 0)) >>> 0);
}

export function hash3(a: number, b: number, c: number): number {
  return pcgHash((a ^ hash2(b, c)) >>> 0);
}

/** Map a hash to a float in [0, 1) using its top 24 bits. */
export function unitFloat(hash: number): number {
  return (hash & 0x00ffffff) / 16777216;
}

/** Per-column falling phase in [0, 1). */
export function columnPhase(column: number, seed: number): number {
  return unitFloat(hash2((column * 2) >>> 0, seed >>> 0));
}

/** Per-column speed randomness in [0, 1). */
export function columnSpeedRandom(column: number, seed: number): number {
  return unitFloat(hash2(((column * 2) + 1) >>> 0, seed >>> 0));
}

/** Non-negative floating modulo, matching GLSL/WGSL `mod` for positive `m`. */
export function positiveMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

export const BASE_PERIOD_CELLS = 22;
export const MIN_SPACING_CELLS = 4;
export const MAX_SPACING_CELLS = 512;

/** Cell spacing between successive heads in a column (in cells). */
export function columnSpacing(pulseDensity: number): number {
  const spacing = BASE_PERIOD_CELLS / Math.max(pulseDensity, 1e-4);
  return Math.min(Math.max(spacing, MIN_SPACING_CELLS), MAX_SPACING_CELLS);
}

export interface RainSample {
  /** Body/trail brightness at this cell before glyph masking, ≥ 0. */
  readonly trail: number;
  /** Bright-head contribution at this cell, 0..1. */
  readonly head: number;
}

export interface RainParameters {
  readonly fallSpeed: number;
  readonly speedVariation: number;
  readonly trailShape: number;
  readonly pulseDensity: number;
  readonly headWidth: number;
  readonly rainStrength: number;
}

/**
 * Procedural (feedback-free) descending trail + head for a cell, purely a
 * function of column, row, seed, and continuous visual time in seconds. Heads
 * fall downward at a per-column speed and repeat every `spacing` cells; the
 * trail fades upward behind each head.
 */
export function sampleRain(
  column: number,
  row: number,
  seed: number,
  timeSeconds: number,
  params: RainParameters,
): RainSample {
  const spacing = columnSpacing(params.pulseDensity);
  const speedRandom = columnSpeedRandom(column, seed);
  const speed = params.fallSpeed * (1 - params.speedVariation * speedRandom);
  const phase = columnPhase(column, seed);
  const headLine = phase * spacing + timeSeconds * speed;
  const distance = positiveMod(headLine - row, spacing); // 0 at head
  const fade = Math.max(0, 1 - distance / spacing);
  const trail = Math.pow(fade, Math.max(params.trailShape, 1e-3)) * params.rainStrength;
  const headEdge = Math.max(params.headWidth, 1e-4);
  const normalized = distance / spacing;
  const head = 1 - smoothstep(0, headEdge, normalized);
  return { trail, head };
}

/** GLSL/WGSL-compatible smoothstep. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Which glyph a cell shows at a given quantized time bucket. The bucket is
 * `floor(timeSeconds * glyphCycleRate)`, so glyphs cycle deterministically and
 * hold steady between buckets (and forever when `glyphCycleRate` is 0).
 */
export function glyphTimeBucket(
  timeSeconds: number,
  glyphCycleRate: number,
): number {
  return Math.floor(Math.max(0, timeSeconds) * glyphCycleRate) >>> 0;
}

export function glyphIndex(
  column: number,
  row: number,
  seed: number,
  bucket: number,
): number {
  return hash3(column >>> 0, row >>> 0, (bucket ^ (seed >>> 0)) >>> 0) % GLYPH_COUNT;
}

export type Vec3 = readonly [number, number, number];

/** Convert a #RRGGBB string to a normalized [r, g, b] vector for uniforms. */
export function colorToVec3(color: string): Vec3 {
  const value = Number.parseInt(color.slice(1), 16);
  return [
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
  ];
}

function mix(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export interface Palette {
  readonly shadow: Vec3;
  readonly body: Vec3;
  readonly bright: Vec3;
}

/**
 * Piecewise body palette: shadow → body → bright across brightness in [0, 1].
 * The head color is added separately by the caller (isolated pale tip).
 */
export function paletteGrade(brightness: number, palette: Palette): Vec3 {
  const b = Math.min(1, Math.max(0, brightness));
  if (b <= 0.5) {
    return mix(palette.shadow, palette.body, b / 0.5);
  }
  return mix(palette.body, palette.bright, (b - 0.5) / 0.5);
}
