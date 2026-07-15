import { Sprite, type Renderer, type RenderTexture, type Texture } from "pixi.js";
import { filterApplicator } from "../../transformations/catalogue/filterFactory";
import { releaseTransformationFilters } from "../../transformations/catalogue/filterRuntime";
import { TransformationSystem } from "../../transformations/catalogue/TransformationRegistry";
import type {
  FilterRenderContext,
  TransformState,
} from "../../transformations/catalogue/types";
import type { ResolvedFilterOp } from "../../transformations/effectMaskFilterOps";

export type { ResolvedFilterOp } from "../../transformations/effectMaskFilterOps";

/**
 * Applies a single resolved filter op to a texture offscreen, rendering the
 * result into a caller-owned render texture. The building block for a masked
 * effect's full-texture pass (`MaskedEffectGpuOps.applyFilter`).
 *
 * It reuses the canonical `filterApplicator` — the very same code the live
 * `sprite.filters` path uses — so the Pixi filter instance and its scaled
 * parameters are constructed identically; only the render *target* differs.
 *
 * The filter is applied in texture/content space (a 1:1, unrotated, unscaled
 * sprite mapping `input` onto `target`), matching the effect-masking model of
 * "apply the effect to the full texture" before clip layout. Spatial filters
 * therefore act in content space here, not post-layout screen space.
 *
 * A retained sprite/filter slot is kept per authored transform ID so a temporal
 * filter's per-instance state survives across frames rather than being recreated
 * every pass. Slots not used by the latest offscreen plan are pruned by
 * {@link retainOnly}, which runs the canonical host filter release path.
 */
export class OffscreenFilterApplicator {
  private readonly renderer: Renderer;
  private readonly slots = new Map<string, Sprite>();

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  applyFilterToTexture(
    input: Texture,
    filterOp: ResolvedFilterOp,
    target: RenderTexture,
    contentSize: { width: number; height: number },
    render?: FilterRenderContext,
  ): void {
    const transformId = filterOp.sourceTransformId ?? filterOp.type;
    const sprite = this.ensureSlot(transformId);
    sprite.texture = input;
    sprite.position.set(0, 0);
    sprite.scale.set(1, 1);
    sprite.rotation = 0;
    sprite.visible = true;

    // Reuse the live filter applicator: builds/configures the Pixi filter from
    // the resolved op exactly as the sprite.filters path would. Because this
    // slot is retained per transform ID, a temporal filter instance attached
    // last frame is found in the pool and reused (never recreated), so its
    // feedback state carries forward.
    const state = {
      ...TransformationSystem.getDefaults(),
      filters: [filterOp],
    } as TransformState;
    try {
      filterApplicator(sprite, state, contentSize, render);
      this.renderer.render({ container: sprite, target, clear: true });
    } catch (error) {
      // A failed update/submission cannot be a valid temporal predecessor.
      // Drop the whole slot so a later attempt starts from a fresh instance.
      this.slots.delete(transformId);
      this.destroySlot(sprite);
      throw error;
    }
  }

  /**
   * Prune retained slots whose transform ID is not in `usedTransformIds`,
   * releasing each slot's filter through the canonical host path and
   * destroying the temporary sprite. Call once after an offscreen plan runs.
   */
  retainOnly(usedTransformIds: ReadonlySet<string>): void {
    for (const [transformId, sprite] of this.slots) {
      if (usedTransformIds.has(transformId)) continue;
      this.slots.delete(transformId);
      this.destroySlot(sprite);
    }
  }

  dispose(): void {
    for (const sprite of this.slots.values()) {
      this.destroySlot(sprite);
    }
    this.slots.clear();
  }

  private ensureSlot(transformId: string): Sprite {
    let sprite = this.slots.get(transformId);
    if (!sprite) {
      sprite = new Sprite();
      sprite.anchor.set(0);
      this.slots.set(transformId, sprite);
    }
    return sprite;
  }

  private destroySlot(sprite: Sprite): void {
    // Release any retained filter before detaching, so implementation cleanup
    // and host destruction run exactly once, then destroy the sprite.
    releaseTransformationFilters(sprite);
    if (!sprite.destroyed) {
      sprite.destroy();
    }
  }
}
