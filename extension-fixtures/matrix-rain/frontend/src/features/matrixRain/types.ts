/**
 * Phase 0 resolved parameter surface. Later phases widen this to the full
 * source/feedback/brightness/palette/composition/debug parameter set described
 * in the extension plan; the baseline keeps a small, representative subset that
 * still exercises numeric, integer, and color controls plus the shared
 * validation path.
 */
export interface MatrixRainParameters {
  /** Glyph grid cell size in rendered pixels. Integer, topology-affecting. */
  readonly size: number;
  /** Deterministic seed for column/glyph variation. Integer. */
  readonly seed: number;
  /** Debug passthrough mix toward matrix green, 0..1. */
  readonly debugTint: number;
  /** Background/base color as #RRGGBB. */
  readonly backgroundColor: string;
}
