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
export const GLYPH_SEGMENT_COUNT = 16;

export interface GlyphCellSample {
  readonly column: number;
  readonly row: number;
  /** Normalized horizontal coordinate within the glyph, in [0, 1). */
  readonly glyphX: number;
  /** Normalized vertical coordinate; values >= 1 are in the row gap. */
  readonly glyphY: number;
  readonly isGlyphRegion: boolean;
}

/**
 * Map a source-space pixel to the shader's glyph grid. Glyphs remain square;
 * only the vertical row pitch grows when spacing is added.
 */
export function sampleGlyphCell(
  pixelX: number,
  pixelY: number,
  sizeValue: number,
  verticalSpacingValue: number,
): GlyphCellSample {
  const size = Math.max(sizeValue, 1);
  const rowPitch = size + Math.max(verticalSpacingValue, 0);
  const column = Math.floor(pixelX / size);
  const row = Math.floor(pixelY / rowPitch);
  const glyphX = positiveMod(pixelX, size) / size;
  const glyphY = positiveMod(pixelY, rowPitch) / size;
  return {
    column,
    row,
    glyphX,
    glyphY,
    isGlyphRegion: glyphY < 1,
  };
}

/**
 * Sixteen original cyber glyphs expressed as combinations of normalized line
 * segments. The shaders rasterize these as analytic, anti-aliased strokes, so
 * increasing Glyph Size adds real edge resolution instead of magnifying a 5×5
 * bitmap. Segment indices are documented beside the shader endpoint tables.
 */
const GLYPH_SEGMENTS: readonly (readonly number[])[] = [
  [0, 4, 5, 6],
  [0, 7],
  [8, 9],
  [0, 4, 7],
  [5, 8, 9],
  [0, 2, 4, 5],
  [0, 2, 4, 5, 6],
  [2, 7],
  [2, 5, 6],
  [0, 2, 4, 6, 10, 13],
  [0, 4, 9],
  [10, 11, 12, 13],
  [8],
  [1, 3, 14, 15],
  [5, 6, 10, 11],
  [5, 6, 12, 13],
];

function encodeGlyphSegments(segments: readonly number[]): number {
  return segments.reduce((mask, segment) => mask | (1 << segment), 0) >>> 0;
}

/** Segment-presence masks shared verbatim with both shader programs. */
export const GLYPH_STROKE_MASKS: readonly number[] =
  GLYPH_SEGMENTS.map(encodeGlyphSegments);

/** True when a procedural glyph contains the requested analytic segment. */
export function glyphUsesSegment(
  glyphIndex: number,
  segment: number,
): boolean {
  const mask = GLYPH_STROKE_MASKS[glyphIndex % GLYPH_COUNT];
  return ((mask >>> segment) & 1) === 1;
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

// ---------------------------------------------------------------------------
// Phase 3: low-resolution temporal feedback
//
// The state texture stores, per glyph cell, four channels:
//   R = accumulated / advected rain brightness
//   G = current procedural head brightness
//   B = current source signal (luma) for the next sample's comparison
//   A = current motion / change signal (introduced in Phase 4; 0 here)
//
// The functions below are the CPU reference for the state-update fragment
// program. They are deterministic and frame-rate independent, and every one
// mirrors the GLSL/WGSL exactly.
// ---------------------------------------------------------------------------

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Rec.709 luma on unpremultiplied linear-ish RGB, matching the shader. */
export function luma(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/**
 * Frame-rate-independent retention factor for a half-life decay: after
 * `halfLifeSeconds` the retained fraction is 0.5, regardless of frame rate.
 * `exp2(-dt / halfLife)`.
 */
export function retention(deltaSeconds: number, halfLifeSeconds: number): number {
  return 2 ** (-Math.max(deltaSeconds, 0) / Math.max(halfLifeSeconds, 1e-4));
}

/**
 * Soft-union accumulation: `1 - (1 - a)(1 - b)`. Combining a decayed trail with
 * new injection this way saturates gracefully toward 1 instead of clipping.
 */
export function softAdd(a: number, b: number): number {
  return 1 - (1 - clamp01(a)) * (1 - clamp01(b));
}

/**
 * The source row a cell's advected rain is read from. Rain descends, so a cell's
 * next value comes from `fallCells` above it. Fractional values are sampled with
 * linear interpolation on the GPU.
 */
export function advectionSourceRow(row: number, fallCells: number): number {
  return row - fallCells;
}

/** Fall distance in cells across one continuous step. */
export function fallCells(fallSpeed: number, deltaSeconds: number): number {
  return fallSpeed * Math.max(deltaSeconds, 0);
}

export interface RainState {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface FeedbackParameters {
  readonly trailHalfLife: number;
  readonly baseInjection: number;
  readonly sourceInfluence: number;
}

export interface RainStateUpdateInput {
  /** Previous rain (R) sampled at the advected (upstream) coordinate. */
  readonly advectedRain: number;
  /** Current source signal (luma) at this cell. */
  readonly currentSignal: number;
  /** Phase-2 procedural trail at this cell; gates static injection. */
  readonly proceduralTrail: number;
  /** Phase-2 procedural head at this cell. */
  readonly proceduralHead: number;
  readonly deltaSeconds: number;
  readonly params: FeedbackParameters;
}

/**
 * One feedback step for a cell. Static source injection is gated by the
 * procedural trail so a still silhouette cannot saturate permanently, and it is
 * further gated to zero on a zero-delta sample so repeated/paused renders never
 * accumulate. The current signal is always written to B, so a newly visible or
 * static feature stays legible through the direct-shape term even before the
 * rain history develops.
 */
export function updateRainState(input: RainStateUpdateInput): RainState {
  const { advectedRain, currentSignal, proceduralTrail, proceduralHead } = input;
  const dt = Math.max(input.deltaSeconds, 0);
  const decayed = advectedRain * retention(dt, input.params.trailHalfLife);
  const injectionGate = dt > 0 ? 1 : 0;
  const injection = clamp01(
    (input.params.baseInjection +
      input.params.sourceInfluence * currentSignal * proceduralTrail) *
      injectionGate,
  );
  return {
    r: softAdd(decayed, injection),
    g: clamp01(proceduralHead),
    b: clamp01(currentSignal),
    a: 0,
  };
}

/**
 * Final glyph body brightness from the state: accumulated rain plus a direct
 * current-shape contribution, so a source shape is recognizable immediately.
 * (Phase 4 adds the motion term `state.a * directMotionStrength`.)
 */
export function rainBodyBrightness(
  state: RainState,
  rainStrength: number,
  directShapeStrength: number,
): number {
  return state.r * rainStrength + state.b * directShapeStrength;
}
