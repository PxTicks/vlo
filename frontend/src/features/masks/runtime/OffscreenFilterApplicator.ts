import { Sprite, type Renderer, type RenderTexture, type Texture } from "pixi.js";
import { filterApplicator } from "../../transformations/catalogue/filterFactory";
import { TransformationSystem } from "../../transformations/catalogue/TransformationRegistry";
import type { TransformState } from "../../transformations/catalogue/types";
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
 */
export class OffscreenFilterApplicator {
  private readonly renderer: Renderer;
  private sprite: Sprite | null = null;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  applyFilterToTexture(
    input: Texture,
    filterOp: ResolvedFilterOp,
    target: RenderTexture,
    contentSize: { width: number; height: number },
  ): void {
    const sprite = this.ensureSprite();
    sprite.texture = input;
    sprite.position.set(0, 0);
    sprite.scale.set(1, 1);
    sprite.rotation = 0;
    sprite.visible = true;

    // Reuse the live filter applicator: builds/configures the Pixi filter from
    // the resolved op exactly as the sprite.filters path would.
    const state = {
      ...TransformationSystem.getDefaults(),
      filters: [filterOp],
    } as TransformState;
    filterApplicator(sprite, state, contentSize);

    try {
      this.renderer.render({ container: sprite, target, clear: true });
    } finally {
      // Clear even if render throws, so the reused sprite never carries a
      // failed pass's filter into the next pass.
      sprite.filters = null;
    }
  }

  dispose(): void {
    if (this.sprite) {
      this.sprite.filters = null;
      if (!this.sprite.destroyed) {
        this.sprite.destroy();
      }
      this.sprite = null;
    }
  }

  private ensureSprite(): Sprite {
    if (!this.sprite) {
      this.sprite = new Sprite();
      this.sprite.anchor.set(0);
    }
    return this.sprite;
  }
}
