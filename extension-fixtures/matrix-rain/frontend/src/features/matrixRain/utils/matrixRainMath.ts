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

import type {
  MatrixAccumulationMode,
  MatrixMotionMode,
  MatrixOutputMode,
  MatrixSignalMode,
} from "../types";

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
 * Original cyber glyphs expressed as combinations of normalized line
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
  [0, 1, 3, 4, 7],
  [0, 2, 4, 7, 14, 15],
  [1, 3, 5, 6, 14, 15],
  [0, 4, 10, 11],
  [2, 8, 9, 12, 13],
  [0, 5, 6, 12, 13],
  [4, 5, 6, 10, 11],
  [1, 2, 3, 7],
];

function encodeGlyphSegments(segments: readonly number[]): number {
  return segments.reduce((mask, segment) => mask | (1 << segment), 0) >>> 0;
}

/** Segment-presence masks shared verbatim with both shader programs. */
export const GLYPH_STROKE_MASKS: readonly number[] =
  GLYPH_SEGMENTS.map(encodeGlyphSegments);
export const GLYPH_COUNT = GLYPH_STROKE_MASKS.length;

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

/** Probability that one stable column/pulse candidate becomes an active stream. */
export function sourceSpawnProbability(
  currentSignal: number,
  motion: number,
  ambientSpawn: number,
  sourceInfluence: number,
  motionInfluence: number,
  spawnRateScale = 1,
): number {
  const drive = clamp01(
    sourceInfluence * currentSignal + motionInfluence * motion,
  );
  const ambient = clamp01(ambientSpawn);
  const baseProbability = 1 - (1 - ambient) * (1 - drive);
  return 1 - Math.pow(1 - baseProbability, Math.max(spawnRateScale, 1e-4));
}

/**
 * Stable Bernoulli decision for a procedural pulse. `pulseIndex` is converted
 * to an unsigned 32-bit key exactly like GLSL's `uint(int(...))` and WGSL's
 * signed-to-unsigned bitcast, including negative pre-roll indices.
 */
export function acceptsSourceSpawn(
  column: number,
  pulseIndex: number,
  seed: number,
  probability: number,
): boolean {
  const noise = unitFloat(
    hash2(hash2(column >>> 0, pulseIndex >>> 0), seed >>> 0),
  );
  return noise < clamp01(probability);
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

function colorChannelToHex(value: number): string {
  return Math.round(clamp01(value) * 255)
    .toString(16)
    .padStart(2, "0");
}

function vec3ToColor(value: Vec3): string {
  return `#${value.map(colorChannelToHex).join("")}`;
}

function mixColor(a: Vec3, b: Vec3, amount: number): Vec3 {
  const t = clamp01(amount);
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** Derive the full Matrix ramp from one authored tint. */
export function deriveMatrixPalette(tint: string): {
  shadowColor: string;
  bodyColor: string;
  brightColor: string;
  headColor: string;
} {
  const body = colorToVec3(tint);
  const black: Vec3 = [0, 0, 0];
  const white: Vec3 = [1, 1, 1];
  return {
    shadowColor: vec3ToColor(mixColor(black, body, 0.3)),
    bodyColor: tint.toLowerCase(),
    brightColor: vec3ToColor(mixColor(body, white, 0.52)),
    headColor: vec3ToColor(mixColor(body, white, 0.84)),
  };
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

// --- Phase 4: edge- and motion-aware source signal -------------------------

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/**
 * CPU reference for the glyph shader's premultiplied-alpha composition.
 * `source` is already premultiplied, while `matrixStraight` is straight RGB.
 */
export function composeMatrixOutput(
  mode: MatrixOutputMode,
  source: Rgba,
  matrixStraight: Vec3,
  coverageValue: number,
  background: Vec3,
): Rgba {
  const coverage = clamp01(coverageValue);
  const straight: Vec3 = [
    clamp01(matrixStraight[0]),
    clamp01(matrixStraight[1]),
    clamp01(matrixStraight[2]),
  ];
  const matrixPremultiplied: Vec3 = [
    straight[0] * coverage,
    straight[1] * coverage,
    straight[2] * coverage,
  ];

  if (mode === "replaceBlack") {
    return {
      r: background[0] * (1 - coverage) + matrixPremultiplied[0],
      g: background[1] * (1 - coverage) + matrixPremultiplied[1],
      b: background[2] * (1 - coverage) + matrixPremultiplied[2],
      a: 1,
    };
  }
  if (mode === "sourceTinted") {
    const alpha = coverage * clamp01(source.a);
    return {
      r: straight[0] * alpha,
      g: straight[1] * alpha,
      b: straight[2] * alpha,
      a: alpha,
    };
  }
  if (mode === "overlaySource") {
    const sourceAlpha = clamp01(source.a);
    const alpha = sourceAlpha + coverage * (1 - sourceAlpha);
    return {
      r: Math.min(
        alpha,
        Math.min(sourceAlpha, clamp01(source.r)) + matrixPremultiplied[0],
      ),
      g: Math.min(
        alpha,
        Math.min(sourceAlpha, clamp01(source.g)) + matrixPremultiplied[1],
      ),
      b: Math.min(
        alpha,
        Math.min(sourceAlpha, clamp01(source.b)) + matrixPremultiplied[2],
      ),
      a: alpha,
    };
  }
  return {
    r: matrixPremultiplied[0],
    g: matrixPremultiplied[1],
    b: matrixPremultiplied[2],
    a: coverage,
  };
}

export interface SignalWeights {
  readonly lumaWeight: number;
  readonly edgeWeight: number;
  readonly edgeGain: number;
  readonly alphaEdgeWeight: number;
}

/** Unpremultiplied Rec.709 luma of a sample (alpha-safe). */
function sampleLuma(sample: Rgba): number {
  const rgb =
    sample.a > 0
      ? { r: sample.r / sample.a, g: sample.g / sample.a, b: sample.b / sample.a }
      : sample;
  return luma(rgb.r, rgb.g, rgb.b);
}

/**
 * Assemble the raw per-cell source signal from the selected mode. Edge modes use
 * a four-neighbour (horizontal + vertical) gradient of luma and/or alpha, so
 * fine line art and transparent silhouettes both register. Threshold/gain/gamma
 * shaping is applied separately by {@link shapeSignal}.
 */
export function assembleSourceSignal(
  mode: MatrixSignalMode,
  center: Rgba,
  left: Rgba,
  right: Rgba,
  up: Rgba,
  down: Rgba,
  weights: SignalWeights,
): number {
  const lumaC = sampleLuma(center);
  const colorEdge =
    (Math.abs(sampleLuma(left) - lumaC) +
      Math.abs(sampleLuma(right) - lumaC) +
      Math.abs(sampleLuma(up) - lumaC) +
      Math.abs(sampleLuma(down) - lumaC)) *
    weights.edgeGain;
  const alphaEdge =
    (Math.abs(left.a - center.a) +
      Math.abs(right.a - center.a) +
      Math.abs(up.a - center.a) +
      Math.abs(down.a - center.a)) *
    weights.edgeGain;

  switch (mode) {
    case "luma":
      return lumaC;
    case "inverseLuma":
      return center.a * (1 - lumaC);
    case "edge":
      return colorEdge;
    case "lumaEdge":
      return weights.lumaWeight * lumaC + weights.edgeWeight * colorEdge;
    case "alpha":
      return center.a;
    case "alphaEdge":
      return (
        weights.alphaEdgeWeight * alphaEdge + weights.edgeWeight * colorEdge
      );
  }
}

/** Apply soft threshold, then gamma, then gain to the assembled signal. */
export function shapeSignal(
  signal: number,
  threshold: number,
  gain: number,
  gamma: number,
): number {
  const above =
    Math.max(0, signal - threshold) / Math.max(1 - threshold, 1e-4);
  return clamp01(Math.pow(clamp01(above), Math.max(gamma, 1e-3)) * gain);
}

/**
 * Motion from the current vs previous source signal. `absolute` reacts to any
 * change; `brightening` reacts only to increases. Thresholded and gained into
 * [0, 1].
 */
export function computeMotion(
  currentSignal: number,
  previousSignal: number,
  mode: MatrixMotionMode,
  threshold: number,
  gain: number,
): number {
  const delta = currentSignal - previousSignal;
  const raw = mode === "brightening" ? Math.max(delta, 0) : Math.abs(delta);
  return clamp01(Math.max(0, raw - threshold) * gain);
}

/** Combine the decayed trail with new injection per the accumulation mode. */
export function accumulate(
  mode: MatrixAccumulationMode,
  decayed: number,
  injection: number,
): number {
  const a = clamp01(decayed);
  const b = clamp01(injection);
  switch (mode) {
    case "max":
      return Math.max(a, b);
    case "add":
      return clamp01(a + b);
    case "softAdd":
      return softAdd(a, b);
  }
}

export interface FeedbackParameters {
  readonly trailHalfLife: number;
  readonly baseInjection: number;
  readonly sourceInfluence: number;
  // Phase 4 motion/accumulation. Optional so Phase 3 callers stay valid: the
  // defaults (no motion, soft-add) reproduce the pure luma-feedback behaviour.
  readonly motionInfluence?: number;
  readonly motionMode?: MatrixMotionMode;
  readonly motionThreshold?: number;
  readonly motionGain?: number;
  readonly motionImmediateAmount?: number;
  readonly injectionStrength?: number;
  readonly darkDamping?: number;
  readonly accumulationMode?: MatrixAccumulationMode;
}

export interface RainStateUpdateInput {
  /** Previous rain (R) sampled at the advected (upstream) coordinate. */
  readonly advectedRain: number;
  /** Previous head vitality (G) sampled at the same advected coordinate. */
  readonly advectedHead?: number;
  /** Current (already shaped) source signal at this cell. */
  readonly currentSignal: number;
  /** Previous source signal (prev state B) at the SAME cell, for motion. */
  readonly previousSignal?: number;
  /** Procedural trail at this cell; gates static injection. */
  readonly proceduralTrail: number;
  /** Procedural head at this cell. */
  readonly proceduralHead: number;
  /** Whether the analytic head crossed this cell between bounded samples. */
  readonly headCrossed?: boolean;
  /** Stable source-conditioned decision for this column/pulse. */
  readonly streamAccepted?: boolean;
  readonly deltaSeconds: number;
  readonly params: FeedbackParameters;
}

/**
 * One feedback step for a cell. A stable per-pulse spawn decision gates the
 * procedural trail, while accepted head vitality is carried in G. Source-aware
 * dark damping applies a continuous, frame-rate-independent survival factor to
 * both historical rain and heads. Injection is zero on a zero-delta sample so
 * repeated/paused renders never accumulate; B/A retain direct source/motion.
 */
export function updateRainState(input: RainStateUpdateInput): RainState {
  const { advectedRain, currentSignal, proceduralTrail, proceduralHead } = input;
  const p = input.params;
  const dt = Math.max(input.deltaSeconds, 0);
  const injectionGate = dt > 0 ? 1 : 0;

  const previousSignal = input.previousSignal ?? currentSignal;
  const motion = computeMotion(
    currentSignal,
    previousSignal,
    p.motionMode ?? "absolute",
    p.motionThreshold ?? 0,
    p.motionGain ?? 0,
  );

  const streamGate = input.streamAccepted === false ? 0 : 1;
  const trailGate = proceduralTrail * streamGate;
  // Motion partially (or fully) bypasses the procedural gate.
  const immediate = p.motionImmediateAmount ?? 0;
  const motionGate =
    streamGate * (proceduralTrail + (1 - proceduralTrail) * immediate);
  const baseInject = p.baseInjection * trailGate;
  const sourceInject = p.sourceInfluence * currentSignal * trailGate;
  const motionInject = (p.motionInfluence ?? 0) * motion * motionGate;
  const injection = clamp01(
    (baseInject + sourceInject + motionInject) *
      (p.injectionStrength ?? 1) *
      injectionGate,
  );

  const sourceSurvival = Math.pow(
    2,
    -dt * Math.max(p.darkDamping ?? 0, 0) * (1 - clamp01(currentSignal)),
  );
  const decayed =
    advectedRain * retention(dt, p.trailHalfLife) * sourceSurvival;
  const carriedHead = (input.advectedHead ?? 0) * sourceSurvival;
  const headSeed = Math.max(proceduralHead, input.headCrossed ? 1 : 0);
  return {
    r: accumulate(p.accumulationMode ?? "softAdd", decayed, injection),
    g: clamp01(Math.max(carriedHead, headSeed * streamGate)),
    b: clamp01(currentSignal),
    a: clamp01(motion),
  };
}

/**
 * Final glyph body brightness from the state: accumulated rain, plus the direct
 * current-shape term (B), plus the direct motion term (A), so a newly visible
 * or moving source is recognizable immediately, before rain history develops.
 */
export function rainBodyBrightness(
  state: RainState,
  rainStrength: number,
  directShapeStrength: number,
  directMotionStrength = 0,
): number {
  return (
    state.r * rainStrength +
    state.b * directShapeStrength +
    state.a * directMotionStrength
  );
}
