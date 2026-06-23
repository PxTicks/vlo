import { RenderTexture, type Texture } from "pixi.js";

/**
 * Ping-pong render targets for the masked-effect chain. Three content-sized
 * textures are enough: within any single chain op at most two *pool* textures
 * are "live" (the running `current` plus, during a masked step, the
 * `effectOutput`), so a third is always free to write into without aliasing a
 * texture being read.
 *
 * The masked composite also reads a coverage texture, but coverage is NOT a
 * pool target — it comes from a separate resolver pool, so it does not count
 * toward the two live targets here. This three-target bound holds ONLY while
 * that stays true: a coverage texture must never be one of these targets, or a
 * filter pass could overwrite it before the composite reads it.
 */
export class EffectChainTexturePool {
  private textures: RenderTexture[] = [];
  private width = 0;
  private height = 0;

  /** Number of pooled textures (diagnostics/tests). */
  get count(): number {
    return this.textures.length;
  }

  /**
   * Ensure three targets sized to `size` exist, recreating on a size change or
   * if any pooled texture has been destroyed. The destroyed check guards the
   * effect-output cache's invalidation path: when a cached output (a pool
   * texture) is destroyed, the renderer misses the cache and re-renders — this
   * must hand back a live target, never the destroyed one.
   */
  ensure(size: { width: number; height: number }): void {
    const width = Math.max(1, Math.round(size.width));
    const height = Math.max(1, Math.round(size.height));
    if (
      this.textures.length === 3 &&
      this.width === width &&
      this.height === height &&
      this.textures.every((texture) => !texture.destroyed)
    ) {
      return;
    }
    this.dispose();
    this.textures = [
      RenderTexture.create({ width, height }),
      RenderTexture.create({ width, height }),
      RenderTexture.create({ width, height }),
    ];
    this.width = width;
    this.height = height;
  }

  /**
   * Return a pooled target distinct from every excluded (live) texture. With
   * three textures and at most two exclusions this always succeeds.
   */
  acquireExcluding(...exclude: Texture[]): RenderTexture {
    for (const texture of this.textures) {
      if (!exclude.includes(texture)) {
        return texture;
      }
    }
    throw new Error(
      "EffectChainTexturePool exhausted: more live textures than targets",
    );
  }

  dispose(): void {
    for (const texture of this.textures) {
      if (!texture.destroyed) {
        texture.destroy(true);
      }
    }
    this.textures = [];
    this.width = 0;
    this.height = 0;
  }
}
