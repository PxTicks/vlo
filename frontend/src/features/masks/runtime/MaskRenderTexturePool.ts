import { RenderTexture } from "pixi.js";

export class MaskRenderTexturePool {
  private perMaskRenderTexture: RenderTexture | null = null;
  private effectMaskRenderTexture: RenderTexture | null = null;
  private presentationMaskRenderTexture: RenderTexture | null = null;
  /** A leaf's distance band, for distance-field edge ops (lazily created). */
  private fieldRenderTexture: RenderTexture | null = null;
  private readonly leafMaskRenderTextures = new Map<string, RenderTexture>();
  private expressionRenderTextures: RenderTexture[] = [];

  public getPerMaskRenderTexture(): RenderTexture | null {
    return this.perMaskRenderTexture;
  }

  public getEffectMaskRenderTexture(): RenderTexture | null {
    return this.effectMaskRenderTexture;
  }

  public getPresentationMaskRenderTexture(): RenderTexture | null {
    return this.presentationMaskRenderTexture;
  }

  public getFieldRenderTexture(): RenderTexture | null {
    return this.fieldRenderTexture;
  }

  public ensureFieldRenderTexture(contentSize: {
    width: number;
    height: number;
  }): void {
    this.fieldRenderTexture = this.resizeTexture(
      this.fieldRenderTexture,
      contentSize,
    );
  }

  public getLeafMaskRenderTexture(maskId: string): RenderTexture | null {
    return this.leafMaskRenderTextures.get(maskId) ?? null;
  }

  public getLeafMaskRenderTextures(): ReadonlyMap<string, RenderTexture> {
    return this.leafMaskRenderTextures;
  }

  public getExpressionRenderTextures(): readonly RenderTexture[] {
    return this.expressionRenderTextures;
  }

  public ensurePerMaskRenderTexture(contentSize: {
    width: number;
    height: number;
  }): void {
    this.perMaskRenderTexture = this.resizeTexture(
      this.perMaskRenderTexture,
      contentSize,
    );
  }

  public ensureEffectMaskRenderTexture(contentSize: {
    width: number;
    height: number;
  }): void {
    this.effectMaskRenderTexture = this.resizeTexture(
      this.effectMaskRenderTexture,
      contentSize,
    );
  }

  public ensurePresentationMaskRenderTexture(contentSize: {
    width: number;
    height: number;
  }): void {
    this.presentationMaskRenderTexture = this.resizeTexture(
      this.presentationMaskRenderTexture,
      contentSize,
    );
  }

  public reconcileLeafMaskRenderTextures(
    maskIds: string[],
    contentSize: { width: number; height: number },
  ): void {
    const wantedMaskIds = new Set(maskIds);

    this.leafMaskRenderTextures.forEach((texture, maskId) => {
      if (wantedMaskIds.has(maskId)) {
        this.resizeTexture(texture, contentSize);
        return;
      }

      texture.destroy(true);
      this.leafMaskRenderTextures.delete(maskId);
    });

    maskIds.forEach((maskId) => {
      const existing = this.leafMaskRenderTextures.get(maskId);
      if (existing) {
        return;
      }

      this.leafMaskRenderTextures.set(
        maskId,
        RenderTexture.create({
          width: contentSize.width,
          height: contentSize.height,
          dynamic: true,
        }),
      );
    });
  }

  public ensureExpressionRenderTextureCount(
    count: number,
    contentSize: { width: number; height: number },
  ): void {
    while (this.expressionRenderTextures.length > count) {
      const texture = this.expressionRenderTextures.pop();
      texture?.destroy(true);
    }

    while (this.expressionRenderTextures.length < count) {
      this.expressionRenderTextures.push(
        RenderTexture.create({
          width: contentSize.width,
          height: contentSize.height,
          dynamic: true,
        }),
      );
    }

    this.expressionRenderTextures = this.expressionRenderTextures.map((texture) =>
      this.resizeTexture(texture, contentSize),
    );
  }

  public dispose(): void {
    this.perMaskRenderTexture?.destroy(true);
    this.perMaskRenderTexture = null;
    this.effectMaskRenderTexture?.destroy(true);
    this.effectMaskRenderTexture = null;
    this.presentationMaskRenderTexture?.destroy(true);
    this.presentationMaskRenderTexture = null;
    this.fieldRenderTexture?.destroy(true);
    this.fieldRenderTexture = null;

    this.leafMaskRenderTextures.forEach((texture) => {
      texture.destroy(true);
    });
    this.leafMaskRenderTextures.clear();

    this.expressionRenderTextures.forEach((texture) => {
      texture.destroy(true);
    });
    this.expressionRenderTextures = [];
  }

  private resizeTexture(
    texture: RenderTexture | null,
    contentSize: { width: number; height: number },
  ): RenderTexture {
    if (!texture) {
      return RenderTexture.create({
        width: contentSize.width,
        height: contentSize.height,
        dynamic: true,
      });
    }

    if (
      texture.width !== contentSize.width ||
      texture.height !== contentSize.height
    ) {
      texture.resize(contentSize.width, contentSize.height);
    }

    return texture;
  }
}
