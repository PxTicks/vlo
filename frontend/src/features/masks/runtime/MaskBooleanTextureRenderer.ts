import {
  BlurFilter,
  Matrix,
  Sprite,
  type Filter,
  type Renderer,
  type Texture,
} from "pixi.js";
import type {
  MaskBooleanExpression,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import type { MaskBooleanExpressionAnalysis } from "../model/maskBooleanExpression";
import {
  createMaskBooleanBlendFilter,
  type MaskBooleanBlendFilter,
} from "../../transformations/catalogue/mask/maskBooleanBlendFilter";
import { createMaskBinaryThresholdFilter } from "../../transformations/catalogue/mask/maskBinaryThresholdFilter";
import { createMaskCleanupFilter } from "../../transformations/catalogue/mask/maskCleanupFilter";
import { createMaskCoverageBoostFilter } from "../../transformations/catalogue/mask/maskCoverageBoostFilter";
import { createMaskCoverageInvertFilter } from "../../transformations/catalogue/mask/maskCoverageInvertFilter";
import { createMaskRedToAlphaFilter } from "../../transformations/catalogue/mask/maskRedToAlphaFilter";
import {
  getSam2MaskGrowAmount,
  isAssetBackedMask,
} from "./AssetMaskSourceFactory";
import type { AssetMaskNode, VectorMaskNode } from "./MaskSceneNodes";
import { MaskRenderTexturePool } from "./MaskRenderTexturePool";
import { MaskSceneNodeRegistry } from "./MaskSceneNodeRegistry";

const MASK_EDGE_BLUR_SCALE = 0.5;

export interface ResolvedMaskCompositeState {
  compositeInvert: boolean;
  growAmount: number;
  growInvert: boolean;
  feather:
    | {
        amount: number;
        mode: "hard_outer" | "soft_inner" | "two_way";
        invert: boolean;
      }
    | null;
}

export class MaskBooleanTextureRenderer {
  private readonly renderer: Renderer;
  private readonly nodeRegistry: MaskSceneNodeRegistry;
  private readonly pool = new MaskRenderTexturePool();
  private readonly maskSprite: Sprite;
  private readonly hasUsableTexture: (sprite: Sprite) => boolean;

  private perMaskSprite: Sprite | null = null;
  private maskBooleanSprite: Sprite | null = null;
  private readonly maskBooleanBlendFilters: Partial<
    Record<"union" | "intersect" | "subtract", MaskBooleanBlendFilter>
  > = {};
  private maskBinaryThresholdFilter: Filter | null = null;
  private maskCleanupFilter: Filter | null = null;
  private maskCoverageBoostFilter: Filter | null = null;
  private maskCoverageInvertFilter: Filter | null = null;
  private maskRedToAlphaFilter: Filter | null = null;
  private blurFilter: BlurFilter | null = null;

  constructor(
    renderer: Renderer,
    nodeRegistry: MaskSceneNodeRegistry,
    maskSprite: Sprite,
    hasUsableTexture: (sprite: Sprite) => boolean,
  ) {
    this.renderer = renderer;
    this.nodeRegistry = nodeRegistry;
    this.maskSprite = maskSprite;
    this.hasUsableTexture = hasUsableTexture;
  }

  public getMaskBooleanBlendFilters(): Partial<
    Record<"union" | "intersect" | "subtract", MaskBooleanBlendFilter>
  > {
    return this.maskBooleanBlendFilters;
  }

  public renderExpressionToTexture(options: {
    expression: MaskBooleanExpression;
    expressionAnalysis: MaskBooleanExpressionAnalysis;
    maskClipByLocalId: Map<string, MaskTimelineClip>;
    contentSize: { width: number; height: number };
    compositeState: ResolvedMaskCompositeState;
  }): Texture | null {
    const referencedMaskIds = options.expressionAnalysis.maskIds;
    if (referencedMaskIds.length === 0) {
      return null;
    }

    this.pool.ensureMaskRenderTexture(options.contentSize);
    this.pool.ensurePerMaskRenderTexture(options.contentSize);
    this.pool.ensureEffectMaskRenderTexture(options.contentSize);
    this.pool.ensurePresentationMaskRenderTexture(options.contentSize);
    this.pool.reconcileLeafMaskRenderTextures(
      referencedMaskIds,
      options.contentSize,
    );
    this.pool.ensureExpressionRenderTextureCount(
      options.expressionAnalysis.operationCount,
      options.contentSize,
    );

    this.renderLeafMaskTextures(
      referencedMaskIds,
      options.maskClipByLocalId,
      options.contentSize,
    );
    const evaluatedTexture = this.evaluateMaskBooleanExpression(
      options.expression,
      { current: 0 },
      options.compositeState.compositeInvert,
      options.maskClipByLocalId,
    );
    if (!evaluatedTexture) {
      return null;
    }

    const effectTexture = this.renderCompositeMaskEdgeTexture(
      evaluatedTexture,
      options.compositeState,
    );
    this.renderPresentedMaskTexture(effectTexture, options.contentSize);
    return effectTexture;
  }

  public dispose(): void {
    if (this.perMaskSprite) {
      this.perMaskSprite.filters = null;
      if (!this.perMaskSprite.destroyed) {
        this.perMaskSprite.destroy();
      }
      this.perMaskSprite = null;
    }
    if (this.maskBooleanSprite) {
      this.maskBooleanSprite.filters = null;
      if (!this.maskBooleanSprite.destroyed) {
        this.maskBooleanSprite.destroy();
      }
      this.maskBooleanSprite = null;
    }
    Object.values(this.maskBooleanBlendFilters).forEach((filter) => {
      filter?.destroy();
    });
    this.maskBinaryThresholdFilter?.destroy();
    this.maskCleanupFilter?.destroy();
    this.maskCoverageBoostFilter?.destroy();
    this.maskCoverageInvertFilter?.destroy();
    this.maskRedToAlphaFilter?.destroy();
    this.blurFilter?.destroy();
    this.pool.dispose();
  }

  private renderLeafMaskTextures(
    referencedMaskIds: string[],
    maskClipByLocalId: Map<string, MaskTimelineClip>,
    contentSize: { width: number; height: number },
  ): void {
    const transform = new Matrix().translate(
      contentSize.width / 2,
      contentSize.height / 2,
    );

    referencedMaskIds.forEach((maskId) => {
      const leafTexture = this.pool.getLeafMaskRenderTexture(maskId);
      if (!leafTexture) {
        return;
      }

      const maskClip = maskClipByLocalId.get(maskId);
      if (
        !maskClip ||
        maskClip.maskMode !== "apply" ||
        !this.isMaskClipRenderable(maskClip)
      ) {
        return;
      }

      if (!maskClip.maskInverted) {
        const growAmount = getSam2MaskGrowAmount(maskClip);
        this.renderMaskSubsetToTexture(
          new Set<string>([maskClip.id]),
          leafTexture,
          transform,
        );
        if (growAmount <= 0) {
          return;
        }

        const grownTexture = this.renderGrowPass(leafTexture, growAmount, false);
        if (grownTexture !== leafTexture) {
          this.renderTextureToTarget(grownTexture, leafTexture, {
            clear: true,
          });
        }
        return;
      }

      const growAmount = getSam2MaskGrowAmount(maskClip);
      const perMaskRenderTexture = this.pool.getPerMaskRenderTexture();
      if (!perMaskRenderTexture) {
        return;
      }

      if (growAmount <= 0) {
        this.renderMaskSubsetToTexture(
          new Set<string>([maskClip.id]),
          perMaskRenderTexture,
          transform,
        );
        this.renderTextureToTarget(perMaskRenderTexture, leafTexture, {
          clear: true,
          filters: [this.getMaskCoverageInvertFilter()],
        });
        return;
      }

      this.renderMaskSubsetToTexture(
        new Set<string>([maskClip.id]),
        leafTexture,
        transform,
      );
      const grownTexture = this.renderGrowPass(leafTexture, growAmount, false);
      this.renderTextureToTarget(grownTexture, leafTexture, {
        clear: true,
        filters: [this.getMaskCoverageInvertFilter()],
      });
    });
  }

  private evaluateMaskBooleanExpression(
    expression: MaskBooleanExpression,
    operationTextureIndex: { current: number },
    compositeInvert: boolean,
    maskClipByLocalId: Map<string, MaskTimelineClip>,
  ): Texture | null {
    if (expression.kind === "mask_ref") {
      return this.resolveRenderableLeafMaskTexture(
        expression.maskId,
        maskClipByLocalId,
      );
    }

    const leftTexture = this.evaluateMaskBooleanExpression(
      expression.left,
      operationTextureIndex,
      compositeInvert,
      maskClipByLocalId,
    );
    const rightTexture = this.evaluateMaskBooleanExpression(
      expression.right,
      operationTextureIndex,
      compositeInvert,
      maskClipByLocalId,
    );
    const targetTexture =
      this.pool.getExpressionRenderTextures()[operationTextureIndex.current] ??
      null;
    operationTextureIndex.current += 1;

    if (!leftTexture || !rightTexture || !targetTexture) {
      return leftTexture ?? rightTexture ?? null;
    }

    this.renderMaskBooleanOperationToTarget(
      leftTexture,
      rightTexture,
      targetTexture,
      expression.operator,
      compositeInvert,
    );
    return targetTexture;
  }

  private renderMaskBooleanOperationToTarget(
    leftTexture: Texture,
    rightTexture: Texture,
    targetTexture: Texture,
    operator: "union" | "intersect" | "subtract",
    compositeInvert: boolean,
  ): void {
    const maskBooleanSprite = this.ensureMaskBooleanSprite();
    const booleanBlendFilter = this.getMaskBooleanBlendFilter(operator);
    booleanBlendFilter.setLeftTexture(leftTexture);
    booleanBlendFilter.setOperateOnInverseCoverage(compositeInvert);

    maskBooleanSprite.texture = rightTexture;
    maskBooleanSprite.position.set(0, 0);
    maskBooleanSprite.scale.set(1, 1);
    maskBooleanSprite.filters = [booleanBlendFilter];

    this.renderer.render({
      container: maskBooleanSprite,
      target: targetTexture,
      clear: true,
    });

    maskBooleanSprite.filters = null;
  }

  private resolveRenderableLeafMaskTexture(
    maskId: string,
    maskClipByLocalId: Map<string, MaskTimelineClip>,
  ): Texture | null {
    const maskClip = maskClipByLocalId.get(maskId);
    if (
      !maskClip ||
      maskClip.maskMode !== "apply" ||
      !this.isMaskClipRenderable(maskClip)
    ) {
      return null;
    }

    return this.pool.getLeafMaskRenderTexture(maskId);
  }

  private renderCompositeMaskEdgeTexture(
    sourceTexture: Texture,
    compositeState: ResolvedMaskCompositeState,
  ): Texture {
    const effectMaskRenderTexture = this.pool.getEffectMaskRenderTexture();
    const perMaskRenderTexture = this.pool.getPerMaskRenderTexture();
    const maskRenderTexture = this.pool.getMaskRenderTexture();
    if (!effectMaskRenderTexture || !perMaskRenderTexture || !maskRenderTexture) {
      return sourceTexture;
    }

    const feather = compositeState.feather;
    const hasEdgeOps =
      compositeState.growAmount > 0 || (feather?.amount ?? 0) > 0;
    if (!hasEdgeOps) {
      return sourceTexture;
    }

    this.renderThresholdPass(sourceTexture, effectMaskRenderTexture);

    let currentTexture: Texture = effectMaskRenderTexture;
    if (compositeState.growAmount > 0) {
      currentTexture = this.renderGrowPass(
        currentTexture,
        compositeState.growAmount,
        compositeState.growInvert,
      );
    }

    if (!feather || feather.amount <= 0) {
      return currentTexture;
    }

    return this.renderFeatherPass(currentTexture, feather);
  }

  private renderPresentedMaskTexture(
    sourceTexture: Texture,
    contentSize: { width: number; height: number },
  ): void {
    this.pool.ensurePresentationMaskRenderTexture(contentSize);
    const presentationMaskRenderTexture =
      this.pool.getPresentationMaskRenderTexture();
    if (!presentationMaskRenderTexture) {
      return;
    }

    this.renderTextureToTarget(sourceTexture, presentationMaskRenderTexture, {
      clear: true,
      filters: [this.getMaskRedToAlphaFilter()],
    });
    this.maskSprite.texture = presentationMaskRenderTexture;
  }

  private renderBlurPass(
    sourceTexture: Texture,
    target: Texture,
    amount: number,
    options: {
      boost?: boolean;
    } = {},
  ): void {
    const filters: Filter[] = [
      this.getMaskCleanupFilter(),
      this.getGaussianBlurFilter(amount),
    ];
    if (options.boost) {
      filters.push(this.getMaskCoverageBoostFilter());
    }
    this.renderTextureToTarget(sourceTexture, target, {
      clear: true,
      filters,
    });
  }

  private renderThresholdPass(sourceTexture: Texture, target: Texture): void {
    this.renderTextureToTarget(sourceTexture, target, {
      clear: true,
      filters: [this.getMaskBinaryThresholdFilter()],
    });
  }

  private renderCoverageInvertPass(
    sourceTexture: Texture,
    target: Texture,
  ): void {
    this.renderTextureToTarget(sourceTexture, target, {
      clear: true,
      filters: [this.getMaskCoverageInvertFilter()],
    });
  }

  private renderGrowPass(
    sourceTexture: Texture,
    amount: number,
    invert: boolean,
  ): Texture {
    if (amount <= 0) {
      return sourceTexture;
    }

    const effectMaskRenderTexture = this.pool.getEffectMaskRenderTexture();
    const perMaskRenderTexture = this.pool.getPerMaskRenderTexture();
    if (!effectMaskRenderTexture || !perMaskRenderTexture) {
      return sourceTexture;
    }

    if (!invert) {
      this.renderBlurPass(sourceTexture, perMaskRenderTexture, amount, {
        boost: true,
      });
      this.renderThresholdPass(perMaskRenderTexture, effectMaskRenderTexture);
      return effectMaskRenderTexture;
    }

    this.renderCoverageInvertPass(sourceTexture, perMaskRenderTexture);
    this.renderBlurPass(perMaskRenderTexture, effectMaskRenderTexture, amount, {
      boost: true,
    });
    this.renderThresholdPass(effectMaskRenderTexture, perMaskRenderTexture);
    this.renderCoverageInvertPass(perMaskRenderTexture, effectMaskRenderTexture);
    return effectMaskRenderTexture;
  }

  private renderFeatherPass(
    sourceTexture: Texture,
    feather: NonNullable<ResolvedMaskCompositeState["feather"]>,
  ): Texture {
    const effectMaskRenderTexture = this.pool.getEffectMaskRenderTexture();
    const perMaskRenderTexture = this.pool.getPerMaskRenderTexture();
    const maskRenderTexture = this.pool.getMaskRenderTexture();
    if (!effectMaskRenderTexture || !perMaskRenderTexture || !maskRenderTexture) {
      return sourceTexture;
    }

    if (!feather.invert) {
      return this.renderFeatherPassInCurrentSpace(sourceTexture, feather);
    }

    const invertedInputTarget = this.pool.getAlternateEffectTarget(sourceTexture);
    if (!invertedInputTarget) {
      return sourceTexture;
    }

    this.renderCoverageInvertPass(sourceTexture, invertedInputTarget);
    const invertedResult = this.renderFeatherPassInCurrentSpace(
      invertedInputTarget,
      {
        amount: feather.amount,
        mode: feather.mode,
      },
    );
    const finalTarget = this.pool.getAlternateEffectTarget(invertedResult);
    if (!finalTarget) {
      return sourceTexture;
    }
    this.renderCoverageInvertPass(invertedResult, finalTarget);
    return finalTarget;
  }

  private renderFeatherPassInCurrentSpace(
    sourceTexture: Texture,
    feather: {
      amount: number;
      mode: "hard_outer" | "soft_inner" | "two_way";
    },
  ): Texture {
    const outputTarget = this.pool.getAlternateEffectTarget(sourceTexture);
    const effectMaskRenderTexture = this.pool.getEffectMaskRenderTexture();
    const perMaskRenderTexture = this.pool.getPerMaskRenderTexture();
    if (!outputTarget || !effectMaskRenderTexture || !perMaskRenderTexture) {
      return sourceTexture;
    }

    if (feather.mode === "two_way") {
      this.renderBlurPass(sourceTexture, perMaskRenderTexture, feather.amount, {
        boost: true,
      });
      this.renderTextureToTarget(perMaskRenderTexture, outputTarget, {
        clear: true,
      });
      this.renderTextureToTarget(sourceTexture, outputTarget, {
        clear: false,
      });
      const finalBlurTarget = this.pool.getAlternateEffectTarget(outputTarget);
      if (!finalBlurTarget) {
        return outputTarget;
      }
      this.renderBlurPass(outputTarget, finalBlurTarget, feather.amount);
      return finalBlurTarget;
    }

    this.renderBlurPass(sourceTexture, perMaskRenderTexture, feather.amount, {
      boost: feather.mode === "hard_outer",
    });

    if (feather.mode === "soft_inner") {
      this.renderTextureToTarget(sourceTexture, outputTarget, {
        clear: true,
      });
      this.renderTextureToTarget(perMaskRenderTexture, outputTarget, {
        clear: false,
        blendMode: "multiply",
      });
      return outputTarget;
    }

    this.renderTextureToTarget(perMaskRenderTexture, outputTarget, {
      clear: true,
    });
    this.renderTextureToTarget(sourceTexture, outputTarget, {
      clear: false,
    });
    return outputTarget;
  }

  private renderTextureToTarget(
    sourceTexture: Texture,
    target: Texture,
    options: {
      clear?: boolean;
      blendMode?: Sprite["blendMode"];
      filters?: Filter[] | null;
    } = {},
  ): void {
    const perMaskSprite = this.ensurePerMaskSprite();
    perMaskSprite.texture = sourceTexture;
    perMaskSprite.filters = options.filters ?? null;
    perMaskSprite.blendMode = options.blendMode ?? "normal";
    perMaskSprite.visible = true;

    this.renderer.render({
      container: perMaskSprite,
      target,
      clear: options.clear ?? true,
    });

    perMaskSprite.filters = null;
    perMaskSprite.blendMode = "normal";
  }

  private ensurePerMaskSprite(): Sprite {
    if (!this.perMaskSprite) {
      this.perMaskSprite = new Sprite();
      this.perMaskSprite.anchor.set(0);
    }
    return this.perMaskSprite;
  }

  private ensureMaskBooleanSprite(): Sprite {
    if (!this.maskBooleanSprite) {
      this.maskBooleanSprite = new Sprite();
      this.maskBooleanSprite.anchor.set(0);
    }

    return this.maskBooleanSprite;
  }

  private getMaskBooleanBlendFilter(
    operator: "union" | "intersect" | "subtract",
  ): MaskBooleanBlendFilter {
    const existingFilter = this.maskBooleanBlendFilters[operator];
    if (existingFilter) {
      return existingFilter;
    }

    const filter = createMaskBooleanBlendFilter(
      operator,
      this.ensureMaskBooleanSprite(),
    );
    this.maskBooleanBlendFilters[operator] = filter;
    return filter;
  }

  private getMaskBinaryThresholdFilter(): Filter {
    if (!this.maskBinaryThresholdFilter) {
      this.maskBinaryThresholdFilter = createMaskBinaryThresholdFilter();
    }
    return this.maskBinaryThresholdFilter;
  }

  private getMaskCleanupFilter(): Filter {
    if (!this.maskCleanupFilter) {
      this.maskCleanupFilter = createMaskCleanupFilter();
    }
    return this.maskCleanupFilter;
  }

  private getMaskCoverageBoostFilter(): Filter {
    if (!this.maskCoverageBoostFilter) {
      this.maskCoverageBoostFilter = createMaskCoverageBoostFilter();
    }
    return this.maskCoverageBoostFilter;
  }

  private getMaskCoverageInvertFilter(): Filter {
    if (!this.maskCoverageInvertFilter) {
      this.maskCoverageInvertFilter = createMaskCoverageInvertFilter();
    }
    return this.maskCoverageInvertFilter;
  }

  private getMaskRedToAlphaFilter(): Filter {
    if (!this.maskRedToAlphaFilter) {
      this.maskRedToAlphaFilter = createMaskRedToAlphaFilter();
    }
    return this.maskRedToAlphaFilter;
  }

  private getGaussianBlurFilter(amount: number): BlurFilter {
    if (!this.blurFilter) {
      this.blurFilter = new BlurFilter();
    }
    const strength = amount * MASK_EDGE_BLUR_SCALE;
    this.blurFilter.strength = strength;
    this.blurFilter.quality = Math.max(4, Math.ceil(strength / 5));
    return this.blurFilter;
  }

  private renderMaskSubsetToTexture(
    maskIds: Set<string>,
    target: Texture,
    transform: Matrix,
  ): void {
    const previousMaskContainerVisibility =
      this.nodeRegistry.getMaskContainer().visible;
    const previousVectorVisibility: Array<{
      node: VectorMaskNode;
      visible: boolean;
    }> = [];
    const previousAssetVisibility: Array<{
      node: AssetMaskNode;
      visible: boolean;
    }> = [];

    this.nodeRegistry.vectorMaskNodes.forEach((node, maskId) => {
      previousVectorVisibility.push({
        node,
        visible: node.root.visible,
      });
      node.root.visible = maskIds.has(maskId);
    });

    this.nodeRegistry.assetMaskNodes.forEach((node, maskId) => {
      previousAssetVisibility.push({
        node,
        visible: node.root.visible,
      });
      node.root.visible =
        maskIds.has(maskId) &&
        node.player.sprite.visible &&
        this.hasUsableTexture(node.player.sprite);
    });

    this.nodeRegistry.getMaskContainer().visible = true;
    try {
      this.renderer.render({
        container: this.nodeRegistry.getMaskContainer(),
        target,
        clear: true,
        transform,
      });
    } finally {
      this.nodeRegistry.getMaskContainer().visible = previousMaskContainerVisibility;
      previousVectorVisibility.forEach((entry) => {
        entry.node.root.visible = entry.visible;
      });
      previousAssetVisibility.forEach((entry) => {
        entry.node.root.visible = entry.visible;
      });
    }
  }

  private isMaskClipRenderable(maskClip: MaskTimelineClip): boolean {
    if (!isAssetBackedMask(maskClip)) {
      return this.nodeRegistry.vectorMaskNodes.has(maskClip.id);
    }

    const sprite = this.nodeRegistry.getAssetNode(maskClip.id)?.player.sprite;
    return !!(sprite && sprite.visible && this.hasUsableTexture(sprite));
  }
}
