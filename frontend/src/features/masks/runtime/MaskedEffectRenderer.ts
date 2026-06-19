import type { Renderer, Texture } from "pixi.js";
import type {
  ClipTransform,
  MaskBooleanExpression,
} from "../../../types/TimelineTypes";
import {
  runMaskedEffectChain,
  type MaskedEffectGpuOps,
} from "../../transformations/maskedEffectChain";
import type { FilterRenderStep } from "../../transformations/effectMaskRenderPlan";
import {
  OffscreenFilterApplicator,
  type ResolvedFilterOp,
} from "./OffscreenFilterApplicator";
import { MaskedEffectCompositor } from "./MaskedEffectCompositor";
import { EffectChainTexturePool } from "./EffectChainTexturePool";

export interface MaskedEffectRenderOptions {
  /**
   * The UNFILTERED source texture (the chain's starting `current`). The render
   * path must pass the freshly decoded/source content each frame, NOT a
   * `sprite.texture` that already holds a previous render's pooled effect
   * output — otherwise repeated renders accumulate effects instead of
   * recomputing from source. The result is a separate pooled texture; the
   * source is only read, never written.
   */
  input: Texture;
  /** Ordered offscreen filter steps from `planTransformRender` (offscreen mode). */
  steps: readonly FilterRenderStep[];
  contentSize: { width: number; height: number };
  /**
   * Resolve a filter transform to its time-sampled filter op. Injected so the
   * renderer stays free of transform-stack time sampling — the render path
   * supplies the same resolved op the live `sprite.filters` path would use.
   */
  resolveFilterOp: (transform: ClipTransform) => ResolvedFilterOp;
  /**
   * Resolve a masked step's expression to a coverage texture, or `null` when
   * none is renderable this frame (e.g. `SpriteClipMaskController
   * .resolveEffectMaskCoverage`). `null` makes the step contribute nothing.
   *
   * MUST return a texture owned by a DIFFERENT pool than this chain's targets
   * (the coverage resolver's own pool) — never an effect-chain target. The
   * composite reads coverage after the filter pass writes `effectOutput`, so a
   * coverage texture that aliased a chain target could be overwritten first.
   */
  resolveCoverage: (expression: MaskBooleanExpression) => Texture | null;
}

/**
 * Assembles the masked-effect GPU ops — offscreen filter application, coverage
 * resolution, and the mix composite — over a ping-pong texture pool, and drives
 * {@link runMaskedEffectChain}. Returns the final texture (the original `input`
 * when the chain is empty or every step is a no-op).
 *
 * The chain's sequencing/safety policy is owned (and unit-tested) by
 * `runMaskedEffectChain`; this class supplies the real GPU mechanisms and the
 * aliasing-free target allocation.
 */
export class MaskedEffectRenderer {
  private readonly filterApplicator: OffscreenFilterApplicator;
  private readonly compositor: MaskedEffectCompositor;
  private readonly pool = new EffectChainTexturePool();

  constructor(renderer: Renderer) {
    this.filterApplicator = new OffscreenFilterApplicator(renderer);
    this.compositor = new MaskedEffectCompositor(renderer);
  }

  render(options: MaskedEffectRenderOptions): Texture {
    if (options.steps.length === 0) {
      return options.input;
    }
    this.pool.ensure(options.contentSize);

    const ops: MaskedEffectGpuOps = {
      applyFilter: (input, transform) => {
        // Exclude only the input being read; the output becomes the new
        // `current` (unmasked) or the `effectOutput` (masked).
        const target = this.pool.acquireExcluding(input);
        this.filterApplicator.applyFilterToTexture(
          input,
          options.resolveFilterOp(transform),
          target,
          options.contentSize,
        );
        return target;
      },
      resolveCoverage: options.resolveCoverage,
      composite: (input, effectOutput, coverage) => {
        // Both reads are live, so the composite target must differ from each.
        const target = this.pool.acquireExcluding(input, effectOutput);
        this.compositor.composite(input, effectOutput, coverage, target);
        return target;
      },
    };

    return runMaskedEffectChain(options.input, options.steps, ops);
  }

  dispose(): void {
    this.filterApplicator.dispose();
    this.compositor.dispose();
    this.pool.dispose();
  }
}
