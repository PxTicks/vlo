/**
 * Phase 2 resolved parameter surface: the stateless Matrix appearance. It adds
 * the glyph grid, procedural motion, brightness, palette, and composition
 * controls on top of the Phase 0 baseline. Later phases widen this again with
 * the source-injection, feedback, and full composition parameters from the
 * extension plan.
 */

/** Opaque black-background glyphs, or transparent premultiplied glyphs. */
export type MatrixOutputMode = "replaceBlack" | "matrixOnly";

/** Diagnostic views; `none` is the normal render. */
export type MatrixDebugMode =
  | "none"
  | "cellGrid"
  | "proceduralTrail"
  | "proceduralHead";

export interface MatrixRainParameters {
  // Grid
  /** Glyph width/height in source pixels. Integer, topology-affecting. */
  readonly size: number;
  /** Empty source pixels inserted between glyph rows. Integer. */
  readonly verticalSpacing: number;
  /** Deterministic seed for column/glyph variation. Integer. */
  readonly seed: number;
  /** Glyph changes per second (0 holds glyphs forever). */
  readonly glyphCycleRate: number;

  // Motion
  /** Head fall speed in cells/second. */
  readonly fallSpeed: number;
  /** Per-column speed randomness, 0..1. */
  readonly speedVariation: number;
  /** Trail falloff exponent (higher = sharper trail). */
  readonly trailShape: number;
  /** Head/pulse density; higher packs more falling heads per column. */
  readonly pulseDensity: number;
  /** Bright-head width as a fraction of the trail, 0.01..0.5. */
  readonly headWidth: number;

  // Brightness
  /** Overall body/trail brightness multiplier. */
  readonly rainStrength: number;
  /** Isolated pale-head brightness multiplier. */
  readonly headIntensity: number;
  /** Low ordered dither magnitude to reduce banding, 0..0.05. */
  readonly ditherMagnitude: number;

  // Palette (#RRGGBB)
  readonly backgroundColor: string;
  readonly shadowColor: string;
  readonly bodyColor: string;
  readonly brightColor: string;
  readonly headColor: string;

  // Composition
  readonly outputMode: MatrixOutputMode;
  readonly debugMode: MatrixDebugMode;
}
