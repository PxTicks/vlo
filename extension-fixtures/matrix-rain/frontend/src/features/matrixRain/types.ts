/**
 * Source-conditioned temporal parameter surface: edge/motion-aware injection
 * plus deterministic stream spawning. It adds a `signal` group (how the
 * source is read: luma / inverse-luma / alpha / edge combinations, then
 * threshold/gain/gamma) and motion controls (compare the current signal with
 * the previous one and inject new bright activity) on top of the Phase 3
 * feedback controls.
 */

/** Opaque black-background glyphs, or transparent premultiplied glyphs. */
export type MatrixOutputMode = "replaceBlack" | "matrixOnly";

/** How the per-cell source signal is derived from the input. */
export type MatrixSignalMode =
  | "luma"
  | "inverseLuma"
  | "edge"
  | "lumaEdge"
  | "alpha"
  | "alphaEdge";

/** How motion is measured from the current vs previous source signal. */
export type MatrixMotionMode = "absolute" | "brightening";

/** How new injection combines with the decayed trail. */
export type MatrixAccumulationMode = "softAdd" | "max" | "add";

/** Diagnostic views; `none` is the normal render. */
export type MatrixDebugMode =
  | "none"
  | "cellGrid"
  | "proceduralTrail"
  | "proceduralHead"
  | "rainState"
  | "advectedPrevious"
  | "currentSignal"
  | "motion"
  | "injection";

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

  // Signal (Phase 4 source read)
  /** How the per-cell source signal is derived. */
  readonly signalMode: MatrixSignalMode;
  /** Weight of the luma term in combined modes, 0..2. */
  readonly lumaWeight: number;
  /** Weight of the colour-edge term in combined modes, 0..2. */
  readonly edgeWeight: number;
  /** Edge gradient gain, 0..8. */
  readonly edgeGain: number;
  /** Weight of the alpha-edge term in alpha modes, 0..2. */
  readonly alphaEdgeWeight: number;
  /** Signal cutoff below which the source is ignored, 0..1. */
  readonly signalThreshold: number;
  /** Post-threshold signal gain, 0..5. */
  readonly signalGain: number;
  /** Post-threshold signal gamma, 0.1..4. */
  readonly signalGamma: number;

  // Feedback (Phase 3 temporal state)
  /** Half-life of the rain trail's decay, in seconds. */
  readonly trailHalfLife: number;
  /** Base injection amplitude within an accepted procedural stream, 0..1. */
  readonly baseInjection: number;
  /** Minimum probability that a procedural stream spawns without source drive. */
  readonly ambientSpawn: number;
  /** How strongly the source signal injects into the rain, 0..2. */
  readonly sourceInfluence: number;
  /** How strongly motion injects new bright activity, 0..2. */
  readonly motionInfluence: number;
  /** How motion is measured. */
  readonly motionMode: MatrixMotionMode;
  /** Motion cutoff below which change is ignored, 0..1. */
  readonly motionThreshold: number;
  /** Motion gain, 0..10. */
  readonly motionGain: number;
  /** How much motion injection bypasses the procedural-trail gate, 0..1. */
  readonly motionImmediateAmount: number;
  /** Overall strength applied to base, source, and motion injection, 0..2. */
  readonly injectionStrength: number;
  /** Additional per-second decay in dark/unsupported source regions, 0..8. */
  readonly darkDamping: number;
  /** How the decayed trail and new injection combine. */
  readonly accumulationMode: MatrixAccumulationMode;
  /** Weight of the immediate current-shape (source signal) term, 0..2. */
  readonly directShapeStrength: number;
  /** Weight of the immediate motion term in the glyph body, 0..2. */
  readonly directMotionStrength: number;

  // Brightness
  /** Overall body/trail brightness multiplier. */
  readonly rainStrength: number;
  /** Isolated pale-head brightness multiplier. */
  readonly headIntensity: number;
  /** How strongly the source signal boosts the head, 0..2. */
  readonly sourceHeadInfluence: number;
  /** How strongly motion boosts the head, 0..2. */
  readonly motionHeadInfluence: number;
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
