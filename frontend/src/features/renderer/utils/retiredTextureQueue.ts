import { Texture } from "pixi.js";

export function destroyTexture(texture: Texture | null | undefined): void {
  if (!texture || texture === Texture.EMPTY || texture.destroyed) return;
  texture.destroy(true);
}

/**
 * Defers destruction of textures until the next frame (or microtask) so that
 * Pixi doesn't null out a texture source mid-render during hot swaps.
 */
export class RetiredTextureQueue {
  private readonly retired = new Set<Texture>();
  private flushHandle: number | ReturnType<typeof setTimeout> | null = null;
  private flushKind: "raf" | "timeout" | null = null;
  private readonly getActiveTexture: () => Texture;

  constructor(getActiveTexture: () => Texture) {
    this.getActiveTexture = getActiveTexture;
  }

  retire(texture: Texture | null | undefined): void {
    if (!texture || texture === Texture.EMPTY || texture.destroyed) return;
    if (texture === this.getActiveTexture()) return;

    this.retired.add(texture);
    this.scheduleFlush();
  }

  flush(): void {
    const activeTexture = this.getActiveTexture();
    for (const texture of this.retired) {
      if (texture === activeTexture) continue;
      destroyTexture(texture);
      this.retired.delete(texture);
    }
  }

  cancel(): void {
    if (this.flushHandle === null) return;

    if (this.flushKind === "raf" && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.flushHandle as number);
    } else {
      clearTimeout(this.flushHandle as ReturnType<typeof setTimeout>);
    }

    this.flushHandle = null;
    this.flushKind = null;
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== null || this.retired.size === 0) {
      return;
    }

    if (typeof requestAnimationFrame === "function") {
      this.flushKind = "raf";
      this.flushHandle = requestAnimationFrame(() => {
        this.flushHandle = null;
        this.flushKind = null;
        this.flush();
      });
      return;
    }

    this.flushKind = "timeout";
    this.flushHandle = setTimeout(() => {
      this.flushHandle = null;
      this.flushKind = null;
      this.flush();
    }, 0);
  }
}
