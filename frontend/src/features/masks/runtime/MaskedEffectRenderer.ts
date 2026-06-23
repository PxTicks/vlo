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
   * Resolve a filter transform to its time-sampled filter op, or `undefined`
   * when it doesn't resolve (unknown/stale filter — see
   * `buildResolvedFilterOpLookup`). Injected so the renderer stays free of
   * transform-stack time sampling. An `undefined` op makes the step a no-op.
   */
  resolveFilterOp: (transform: ClipTransform) => ResolvedFilterOp | undefined;
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
  /**
   * Optional identity of everything this render depends on (source frame, filter
   * params, content size, mask coverage). When the previous render carried the
   * same key, its pooled output is returned without re-running any GPU pass —
   * the stable/paused case. Omit (or vary) the key to force a fresh render.
   *
   * Soundness rests on the renderer being single-consumer (one per engine) and
   * the pool being touched only by `render`: between two same-key calls nothing
   * overwrites the cached pool output, so it still holds the cached content. A
   * differing key always re-renders, and the cache is dropped when the cached
   * texture is destroyed.
   */
  cacheKey?: string;
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
  private cached: { key: string; output: Texture } | null = null;

  constructor(renderer: Renderer) {
    this.filterApplicator = new OffscreenFilterApplicator(renderer);
    this.compositor = new MaskedEffectCompositor(renderer);
  }

  render(options: MaskedEffectRenderOptions): Texture {
    const { cacheKey } = options;
    if (
      cacheKey !== undefined &&
      this.cached?.key === cacheKey &&
      !this.cached.output.destroyed
    ) {
      return this.cached.output;
    }

    if (options.steps.length === 0) {
      // No GPU work; the input passes through. Still cache it so a same-key
      // follow-up short-circuits identically (and so a later differing key
      // correctly drops this entry).
      this.cached =
        cacheKey !== undefined ? { key: cacheKey, output: options.input } : null;
      return options.input;
    }
    this.pool.ensure(options.contentSize);

    const ops: MaskedEffectGpuOps = {
      applyFilter: (input, transform) => {
        const filterOp = options.resolveFilterOp(transform);
        // An unresolved (unknown/stale) filter contributes nothing: pass the
        // input through untouched rather than crash on a missing op.
        if (!filterOp) {
          return input;
        }
        // Exclude only the input being read; the output becomes the new
        // `current` (unmasked) or the `effectOutput` (masked).
        const target = this.pool.acquireExcluding(input);
        this.filterApplicator.applyFilterToTexture(
          input,
          filterOp,
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

    const output = runMaskedEffectChain(options.input, options.steps, ops);
    this.cached = cacheKey !== undefined ? { key: cacheKey, output } : null;
    return output;
  }

  dispose(): void {
    this.cached = null;
    this.filterApplicator.dispose();
    this.compositor.dispose();
    this.pool.dispose();
  }
}
