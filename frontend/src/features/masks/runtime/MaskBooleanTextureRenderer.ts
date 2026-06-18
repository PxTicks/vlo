import { type Sprite, type Renderer, type Texture } from "pixi.js";
import type {
  MaskBooleanExpression,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import type { MaskBooleanExpressionAnalysis } from "../model/maskBooleanExpression";
import type { MaskBooleanBlendFilter } from "../../transformations/catalogue/mask/maskBooleanBlendFilter";
import { MaskSceneNodeRegistry } from "./MaskSceneNodeRegistry";
import {
  MaskTextureResolver,
  type ResolvedMaskCompositeState,
} from "./MaskTextureResolver";

export type { ResolvedMaskCompositeState } from "./MaskTextureResolver";

interface CachedCompositeTexture {
  cacheKey: string;
  effectTexture: Texture;
  presentationTexture: Texture;
}

/**
 * Alpha-mask presentation wrapper around {@link MaskTextureResolver}.
 *
 * The resolver owns the sprite-independent expression→coverage GPU pipeline;
 * this class adds the two things specific to applying that coverage as a clip's
 * alpha mask: presenting the coverage into the `maskSprite`'s texture, and
 * caching the composite so an unchanged mask frame is not re-rendered. The
 * cache is validated against `maskSprite.texture` so an external reassignment
 * (e.g. `clear()`) forces a re-render — behaviour preserved from when the
 * pipeline lived here directly.
 */
export class MaskBooleanTextureRenderer {
  private readonly maskSprite: Sprite;
  private readonly resolver: MaskTextureResolver;
  private cachedCompositeTexture: CachedCompositeTexture | null = null;

  constructor(
    renderer: Renderer,
    nodeRegistry: MaskSceneNodeRegistry,
    maskSprite: Sprite,
    hasUsableTexture: (sprite: Sprite) => boolean,
  ) {
    this.maskSprite = maskSprite;
    this.resolver = new MaskTextureResolver(
      renderer,
      nodeRegistry,
      hasUsableTexture,
    );
  }

  public getMaskBooleanBlendFilters(): Partial<
    Record<"union" | "intersect" | "subtract", MaskBooleanBlendFilter>
  > {
    return this.resolver.getMaskBooleanBlendFilters();
  }

  public renderExpressionToTexture(options: {
    expression: MaskBooleanExpression;
    expressionAnalysis: MaskBooleanExpressionAnalysis;
    maskClipByLocalId: Map<string, MaskTimelineClip>;
    contentSize: { width: number; height: number };
    compositeState: ResolvedMaskCompositeState;
    cacheKey?: string;
  }): Texture | null {
    if (options.expressionAnalysis.maskIds.length === 0) {
      this.invalidateCache();
      return null;
    }

    if (
      options.cacheKey &&
      this.cachedCompositeTexture?.cacheKey === options.cacheKey &&
      !this.cachedCompositeTexture.effectTexture.destroyed &&
      !this.cachedCompositeTexture.presentationTexture.destroyed &&
      this.maskSprite.texture === this.cachedCompositeTexture.presentationTexture
    ) {
      return this.cachedCompositeTexture.effectTexture;
    }

    const effectTexture = this.resolver.resolveCoverageTexture(options);
    if (!effectTexture) {
      this.invalidateCache();
      return null;
    }

    const presentationTexture = this.resolver.renderPresentationTexture(
      effectTexture,
      options.contentSize,
    );
    if (presentationTexture) {
      this.maskSprite.texture = presentationTexture;
    }
    this.cachedCompositeTexture = options.cacheKey
      ? {
          cacheKey: options.cacheKey,
          effectTexture,
          presentationTexture: this.maskSprite.texture,
        }
      : null;
    return effectTexture;
  }

  public invalidateCache(): void {
    this.cachedCompositeTexture = null;
  }

  public dispose(): void {
    this.invalidateCache();
    this.resolver.dispose();
  }
}
