import type { Texture } from "pixi.js";
import type {
  ClipTransform,
  MaskBooleanExpression,
} from "../../types/TimelineTypes";
import type { FilterRenderStep } from "./effectMaskRenderPlan";

/**
 * The GPU operations a masked-effect chain needs, abstracted from the chain's
 * sequencing policy. The real implementation (next integration step) binds
 * these to a Pixi renderer + filter factory + `MaskTextureResolver` + a mix
 * composite; the policy below stays pure so its correctness rules are testable
 * with a mock renderer.
 */
export interface MaskedEffectGpuOps {
  /**
   * Apply one filter transform to the full input texture, returning the result.
   * Used for both unmasked steps (in place) and the masked branch's effect.
   */
  applyFilter: (input: Texture, transform: ClipTransform) => Texture;
  /**
   * Resolve the coverage (mask-alpha) texture for a masked step's expression,
   * or `null` when no coverage is renderable *this frame* — e.g. the referenced
   * masks are inactive at this source time, or a SAM2/asset mask frame is not
   * ready yet. `null` MUST make the effect contribute nothing (see the chain).
   */
  resolveCoverage: (expression: MaskBooleanExpression) => Texture | null;
  /**
   * Composite the masked branch: `out = mix(input, effectOutput, coverage)` —
   * reveal the effect output through the coverage alpha over the untouched
   * input.
   */
  composite: (
    input: Texture,
    effectOutput: Texture,
    coverage: Texture,
  ) => Texture;
}

/**
 * Run an offscreen filter chain (from `planTransformRender`'s `offscreen` mode)
 * over an input texture, threading each step's output into the next.
 *
 * Sequencing/safety policy (the part worth testing without a GPU):
 *  - `unmasked`: apply the filter to the running texture in place.
 *  - `empty`: contribute nothing — the running texture passes through unchanged.
 *  - `masked` with renderable coverage: apply the filter to the running texture,
 *    then composite that effect output back through the coverage alpha.
 *  - `masked` with NO renderable coverage (`resolveCoverage` → null): contribute
 *    nothing. This is the crucial rule — a masked effect whose mask isn't ready
 *    must NOT fall back to applying the effect to the whole clip.
 *
 * Returns the final texture. If every step is a no-op (all empty / all masked
 * without coverage) the original `input` is returned unchanged.
 */
export function runMaskedEffectChain(
  input: Texture,
  steps: readonly FilterRenderStep[],
  ops: MaskedEffectGpuOps,
): Texture {
  let current = input;

  for (const step of steps) {
    const resolution = step.resolution;

    if (resolution.kind === "empty") {
      continue;
    }

    if (resolution.kind === "unmasked") {
      current = ops.applyFilter(current, step.transform);
      continue;
    }

    // masked
    const coverage = ops.resolveCoverage(resolution.expression);
    if (!coverage) {
      // Mask unavailable this frame -> the effect contributes nothing. Never
      // apply the filter to the whole clip as a fallback.
      continue;
    }
    const effectOutput = ops.applyFilter(current, step.transform);
    current = ops.composite(current, effectOutput, coverage);
  }

  return current;
}
