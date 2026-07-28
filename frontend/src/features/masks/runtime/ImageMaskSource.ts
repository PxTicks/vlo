import { Sprite, Texture } from "pixi.js";
import type { Asset } from "../../../types/Asset";
import type { SourceFrameSyncRef } from "../../renderer";
import { ensureAssetSourceLoaded } from "../../userAssets";

export interface ImageMaskGeometryContext {
  canvasWidth: number;
  canvasHeight: number;
  imageBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Renderer-independent source for immutable image masks.
 *
 * Unlike a RenderTexture, the image remains the CPU-side source of truth and
 * Pixi uploads it independently for each renderer that presents the sprite.
 */
export class ImageMaskSource {
  public readonly sprite: Sprite;

  private readonly onFrameReady: (() => void) | undefined;
  private currentAssetId: string | null = null;
  private geometryContext: ImageMaskGeometryContext | null = null;
  private geometrySignature = "";
  private texture: Texture | null = null;
  private loadGeneration = 0;
  private disposed = false;

  constructor(onFrameReady?: () => void) {
    this.onFrameReady = onFrameReady;
    this.sprite = new Sprite();
    this.sprite.anchor.set(0.5);
    this.sprite.visible = false;
  }

  public setGeometryContext(context: ImageMaskGeometryContext): void {
    const normalized: ImageMaskGeometryContext = {
      canvasWidth: Math.max(1, Math.round(context.canvasWidth)),
      canvasHeight: Math.max(1, Math.round(context.canvasHeight)),
      imageBounds: {
        x: context.imageBounds.x,
        y: context.imageBounds.y,
        width: Math.max(1, context.imageBounds.width),
        height: Math.max(1, context.imageBounds.height),
      },
    };
    const signature = JSON.stringify(normalized);
    if (signature === this.geometrySignature) {
      return;
    }

    this.geometryContext = normalized;
    this.geometrySignature = signature;
    this.loadGeneration += 1;
    this.clearTexture();
  }

  public async setSource(asset: Asset): Promise<void> {
    if (this.disposed) return;
    if (this.currentAssetId === asset.id && this.texture) {
      return;
    }

    if (this.currentAssetId !== asset.id) {
      // A failed replacement must resolve to empty coverage, never pixels from
      // the previously bound mask.
      this.clearTexture();
    }
    this.currentAssetId = asset.id;
    const generation = ++this.loadGeneration;
    const hydratedAsset = await ensureAssetSourceLoaded(asset.id);
    if (!this.isLoadCurrent(asset.id, generation)) {
      return;
    }

    const resolvedAsset = hydratedAsset ?? asset;
    if (!resolvedAsset.src) {
      this.clearTexture();
      return;
    }

    const image = new Image();
    image.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Failed to load image mask"));
      image.src = resolvedAsset.src;
    });
    if (!this.isLoadCurrent(asset.id, generation)) {
      return;
    }

    const textureSource = this.createTextureSource(image);
    const texture = Texture.from(textureSource);
    this.replaceTexture(texture);
    this.sprite.width = this.geometryContext?.canvasWidth ??
      Math.max(1, image.naturalWidth || texture.width);
    this.sprite.height = this.geometryContext?.canvasHeight ??
      Math.max(1, image.naturalHeight || texture.height);
    this.sprite.visible = true;
    this.onFrameReady?.();
  }

  public async renderAt(
    sourceFrame: SourceFrameSyncRef,
    options: { strict?: boolean } = {},
  ): Promise<void> {
    void sourceFrame;
    void options;
  }

  public hasFrame(): boolean {
    return this.texture !== null && this.sprite.visible;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadGeneration += 1;
    this.clearTexture();
    if (!this.sprite.destroyed) {
      this.sprite.destroy();
    }
  }

  private isLoadCurrent(assetId: string, generation: number): boolean {
    return (
      !this.disposed &&
      this.currentAssetId === assetId &&
      this.loadGeneration === generation
    );
  }

  private replaceTexture(texture: Texture): void {
    const previous = this.texture;
    this.texture = texture;
    this.sprite.texture = texture;
    if (previous && previous !== texture && !previous.destroyed) {
      previous.destroy(true);
    }
  }

  private createTextureSource(
    image: HTMLImageElement,
  ): HTMLImageElement | HTMLCanvasElement {
    const context = this.geometryContext;
    if (!context) {
      return image;
    }

    const canvas = document.createElement("canvas");
    canvas.width = context.canvasWidth;
    canvas.height = context.canvasHeight;
    const canvasContext = canvas.getContext("2d");
    if (!canvasContext) {
      throw new Error("Failed to create image mask canvas");
    }
    canvasContext.fillStyle = "#000";
    canvasContext.fillRect(0, 0, canvas.width, canvas.height);
    canvasContext.drawImage(
      image,
      context.imageBounds.x,
      context.imageBounds.y,
      context.imageBounds.width,
      context.imageBounds.height,
    );
    return canvas;
  }

  private clearTexture(): void {
    const previous = this.texture;
    this.texture = null;
    this.sprite.texture = Texture.EMPTY;
    this.sprite.visible = false;
    if (previous && !previous.destroyed) {
      previous.destroy(true);
    }
  }
}
