import { Sprite, type Renderer, type RenderTexture, type Texture } from "pixi.js";
import {
  MaskedEffectMixFilter,
  createMaskedEffectMixFilter,
} from "../../transformations/catalogue/mask/maskedEffectMixFilter";

/**
 * Composites a masked effect into a render texture in a single pass:
 * `out = mix(input, effectOutput, coverage.r)` via {@link MaskedEffectMixFilter}.
 * The `composite` mechanism of `MaskedEffectGpuOps`.
 *
 * A carrier sprite holds `input` (the filter's base/`uTexture`); the mix filter
 * binds `effectOutput` and `coverage` as extra samplers and the sprite is
 * rendered to the target. Single 1:1 pass (anchor 0, identity transform).
 *
 * `coverage` is the RAW red-channel coverage from
 * `MaskTextureResolver.resolveCoverageTexture` — the shader reads `coverage.r`,
 * so no red→alpha presentation pass is required. Mixing in premultiplied space
 * makes the result exact `mix` for any source alpha (opaque or transparent).
 *
 * NOTE: the render call + filter wiring are unit-tested, but the composited
 * pixels (the shader's coordinate alignment + mix) need a real renderer to
 * verify — confirm visually when wired into the render path.
 */
export class MaskedEffectCompositor {
  private readonly renderer: Renderer;
  private sprite: Sprite | null = null;
  private filter: MaskedEffectMixFilter | null = null;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  composite(
    input: Texture,
    effectOutput: Texture,
    coverage: Texture,
    target: RenderTexture,
  ): void {
    const sprite = this.ensureSprite();
    const filter = this.ensureFilter(sprite);

    sprite.texture = input;
    sprite.position.set(0, 0);
    sprite.scale.set(1, 1);
    sprite.rotation = 0;
    sprite.visible = true;

    filter.setEffectTexture(effectOutput);
    filter.setCoverageTexture(coverage);
    sprite.filters = [filter];

    try {
      this.renderer.render({ container: sprite, target, clear: true });
    } finally {
      // Clear even if render throws, so the reused sprite never carries the
      // mix filter (with stale bound textures) into an unrelated render.
      sprite.filters = null;
    }
  }

  dispose(): void {
    this.filter?.destroy();
    this.filter = null;
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

  private ensureFilter(referenceSprite: Sprite): MaskedEffectMixFilter {
    if (!this.filter) {
      this.filter = createMaskedEffectMixFilter(referenceSprite);
    }
    return this.filter;
  }
}
