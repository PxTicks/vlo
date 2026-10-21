import {
  Matrix,
  Sprite,
  type Filter,
  type RenderTexture,
  type Renderer,
  type Texture,
} from "pixi.js";
import type {
  MaskBooleanExpression,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import {
  collectMaskBooleanLeafVariants,
  getMaskBooleanLeafKey,
  type MaskBooleanExpressionAnalysis,
  type MaskBooleanLeafVariant,
} from "../model/maskBooleanExpression";
import {
  createMaskBooleanBlendFilter,
  type MaskBooleanBlendFilter,
} from "../../transformations/catalogue/mask/maskBooleanBlendFilter";
import { createMaskCoverageInvertFilter } from "../../transformations/catalogue/mask/maskCoverageInvertFilter";
import { createMaskRedToAlphaFilter } from "../../transformations/catalogue/mask/maskRedToAlphaFilter";
import {
  composeMaskEdgeShapeOverLeaf,
  hasMaskEdgeOps,
  invertMaskEdgeShape,
  planMaskEdgeStages,
  resolveMaskEdgeShape,
  type MaskEdgeOps,
} from "../utils/maskEdgeProfile";
import {
  multiplyAffine,
  resolveAssetFieldGeometry,
  type AssetFieldGeometry,
} from "../utils/maskAssetGeometry";
import { resolveDistanceFieldBand } from "../model/maskAssetEncoding";
import {
  canShapeMaskUnionFromField,
  combineMaskFieldQuality,
  type MaskFieldQuality,
} from "../utils/maskFieldComposition";
import type { MaskAssetDecodeOutput } from "./MaskAssetDecodeFilter";
import { getSam2MaskGrowAmount } from "./AssetMaskSourceFactory";
import { MaskDistanceFieldRenderer } from "./distanceField/MaskDistanceFieldRenderer";
import type { AssetMaskNode, VectorMaskNode } from "./MaskSceneNodes";
import { MaskRenderTexturePool } from "./MaskRenderTexturePool";
import { MaskSceneNodeRegistry } from "./MaskSceneNodeRegistry";

/** Edge ops are authored in content pixels; mask textures are content-sized. */
function texelsPerContentPixel(
  texture: Texture,
  contentSize: { width: number; height: number },
): number {
  return contentSize.width > 0
    ? texture.source.pixelWidth / contentSize.width
    : 1;
}

/** Renders mask nodes centred in a content-sized target. */
function contentTransform(contentSize: { width: number; height: number }): Matrix {
  return new Matrix().translate(contentSize.width / 2, contentSize.height / 2);
}

/** How a node's frame sprite sits in content space; see maskAssetGeometry. */
function resolveNodeFieldGeometry(
  node: AssetMaskNode,
  contentSize: { width: number; height: number },
): AssetFieldGeometry {
  const { sprite } = node.player;
  sprite.updateLocalTransform();
  node.root.updateLocalTransform();
  const spriteToContent = multiplyAffine(
    contentTransform(contentSize),
    multiplyAffine(node.root.localTransform, sprite.localTransform),
  );
  return resolveAssetFieldGeometry(spriteToContent, sprite.visualBounds, contentSize);
}

export function toMaskEdgeOps(
  compositeState: ResolvedMaskCompositeState,
): MaskEdgeOps {
  return {
    growPx: compositeState.growAmount,
    growInvert: compositeState.growInvert,
    feather: compositeState.feather
      ? {
          amountPx: compositeState.feather.amount,
          mode: compositeState.feather.mode,
          invert: compositeState.feather.invert,
        }
      : null,
  };
}

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

export interface ResolveMaskCoverageOptions {
  expression: MaskBooleanExpression;
  expressionAnalysis: MaskBooleanExpressionAnalysis;
  maskClipByLocalId: Map<string, MaskTimelineClip>;
  contentSize: { width: number; height: number };
  compositeState: ResolvedMaskCompositeState;
}

export type ProbeMaskCoverageOptions = Pick<
  ResolveMaskCoverageOptions,
  "expressionAnalysis" | "maskClipByLocalId"
>;

interface ResolvedMaskTexture {
  texture: Texture;
  field: MaskFieldQuality | null;
}

/**
 * Sprite-independent GPU pipeline that turns a mask boolean expression into a
 * coverage texture: normalize leaves to distance bands, evaluate booleans in
 * field space, then re-distance for the composite edge ops. Single leaves
 * retain their direct coverage and stored-band fast paths.
 *
 * Extracted from `MaskBooleanTextureRenderer` so the same pipeline can serve
 * both the alpha-mask presentation path (today, via that renderer) and
 * effect-level masking (later) without dragging along the alpha-mask sprite or
 * its cache. It owns the render-texture pool, the reusable scratch sprites, and
 * the mask filters; it does NOT own any presentation target and performs no
 * caching — both belong to the consumer.
 *
 * It reads mask scene nodes from the shared `MaskSceneNodeRegistry`, so the
 * caller must have synced/positioned the referenced mask nodes before calling
 * {@link resolveCoverageTexture}.
 */
export class MaskTextureResolver {
  private readonly renderer: Renderer;
  private readonly nodeRegistry: MaskSceneNodeRegistry;
  private readonly pool = new MaskRenderTexturePool();
  private readonly hasUsableTexture: (sprite: Sprite) => boolean;

  private perMaskSprite: Sprite | null = null;
  private maskBooleanSprite: Sprite | null = null;
  private readonly maskBooleanBlendFilters: Partial<
    Record<"union" | "intersect" | "subtract", MaskBooleanBlendFilter>
  > = {};
  private maskCoverageInvertFilter: Filter | null = null;
  private maskRedToAlphaFilter: Filter | null = null;
  private readonly distanceFieldRenderer: MaskDistanceFieldRenderer;

  constructor(
    renderer: Renderer,
    nodeRegistry: MaskSceneNodeRegistry,
    hasUsableTexture: (sprite: Sprite) => boolean,
  ) {
    this.renderer = renderer;
    this.nodeRegistry = nodeRegistry;
    this.hasUsableTexture = hasUsableTexture;
    this.distanceFieldRenderer = new MaskDistanceFieldRenderer(renderer);
  }

  public getMaskBooleanBlendFilters(): Partial<
    Record<"union" | "intersect" | "subtract", MaskBooleanBlendFilter>
  > {
    return this.maskBooleanBlendFilters;
  }

  /** Cheap node/texture probe used before deciding whether a GPU resolve is needed. */
  public hasRenderableCoverage(options: ProbeMaskCoverageOptions): boolean {
    return options.expressionAnalysis.maskIds.some((maskId) => {
      const maskClip = options.maskClipByLocalId.get(maskId);
      return !!(maskClip && this.isMaskClipRenderable(maskClip));
    });
  }

  /**
   * Resolve the expression to a coverage texture (red channel = coverage), or
   * `null` when there is nothing renderable. Does not present or cache.
   */
  public resolveCoverageTexture(
    options: ResolveMaskCoverageOptions,
  ): Texture | null {
    const referencedMaskIds = options.expressionAnalysis.maskIds;
    if (referencedMaskIds.length === 0) {
      return null;
    }

    this.pool.ensurePerMaskRenderTexture(options.contentSize);
    this.pool.ensureEffectMaskRenderTexture(options.contentSize);
    this.pool.ensurePresentationMaskRenderTexture(options.contentSize);

    // A lone distance-band mask with edge ops is shaped straight from its
    // band, its own grow and inversion folded in; no leaf coverage needed.
    const singleLeafEdge = this.renderSingleLeafEdgeFromField(options);
    if (singleLeafEdge) {
      return singleLeafEdge;
    }

    const leafVariants = collectMaskBooleanLeafVariants(options.expression);
    this.pool.reconcileLeafMaskRenderTextures(
      leafVariants.map((variant) =>
        getMaskBooleanLeafKey(variant.maskId, variant.inverted),
      ),
      options.contentSize,
    );
    this.pool.ensureExpressionRenderTextureCount(
      options.expressionAnalysis.operationCount,
      options.contentSize,
    );

    const fieldQualities =
      options.expression.kind === "operation"
        ? this.renderLeafMaskFields(
            leafVariants,
            options.maskClipByLocalId,
            options.contentSize,
          )
        : undefined;
    if (!fieldQualities) {
      this.renderLeafMaskTextures(
        leafVariants,
        options.maskClipByLocalId,
        options.contentSize,
      );
    }
    const evaluatedTexture = this.evaluateMaskBooleanExpression(
      options.expression,
      { current: 0 },
      options.compositeState.compositeInvert,
      options.maskClipByLocalId,
      fieldQualities,
    );
    if (!evaluatedTexture) {
      return null;
    }

    const singleMask = options.expression.kind === "mask_ref"
      ? options.maskClipByLocalId.get(options.expression.maskId)
      : undefined;

    return this.renderCompositeMaskEdgeTexture(
      evaluatedTexture.texture,
      options.compositeState,
      options.contentSize,
      evaluatedTexture.field,
      singleMask ? this.coverageSeedKind(singleMask) : "antialiased",
    );
  }

  /**
   * Render a coverage texture into a presentation (red→alpha) texture, returned
   * for the caller to apply (e.g. as an AlphaMask sprite texture). Returns
   * `null` if the presentation render texture is unavailable. Writes no sprite.
   */
  public renderPresentationTexture(
    sourceTexture: Texture,
    contentSize: { width: number; height: number },
  ): Texture | null {
    this.pool.ensurePresentationMaskRenderTexture(contentSize);
    const presentationMaskRenderTexture =
      this.pool.getPresentationMaskRenderTexture();
    if (!presentationMaskRenderTexture) {
      return null;
    }

    this.renderTextureToTarget(sourceTexture, presentationMaskRenderTexture, {
      clear: true,
      filters: [this.getMaskRedToAlphaFilter()],
    });
    return presentationMaskRenderTexture;
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
    this.maskCoverageInvertFilter?.destroy();
    this.maskRedToAlphaFilter?.destroy();
    this.distanceFieldRenderer.dispose();
    this.pool.dispose();
  }

  private renderLeafMaskTextures(
    leafVariants: readonly MaskBooleanLeafVariant[],
    maskClipByLocalId: Map<string, MaskTimelineClip>,
    contentSize: { width: number; height: number },
  ): void {
    const transform = contentTransform(contentSize);

    leafVariants.forEach((variant) => {
      const leafTexture = this.pool.getLeafMaskRenderTexture(
        getMaskBooleanLeafKey(variant.maskId, variant.inverted),
      );
      if (!leafTexture) {
        return;
      }

      const maskClip = maskClipByLocalId.get(variant.maskId);
      if (!maskClip || !this.isMaskClipRenderable(maskClip)) {
        return;
      }

      // Equation-level inversion composes with the clip's own inversion, so
      // inverting an inverted mask is a passthrough to its plain coverage
      // (per-mask grow is applied before inversion, so it survives intact).
      const renderInverted = maskClip.maskInverted !== variant.inverted;
      const growAmount = getSam2MaskGrowAmount(maskClip);
      const perMaskRenderTexture = this.pool.getPerMaskRenderTexture();

      if (growAmount !== 0) {
        if (!perMaskRenderTexture) {
          return;
        }
        const growShape = resolveMaskEdgeShape(
          { growPx: growAmount, growInvert: false, feather: null },
          texelsPerContentPixel(leafTexture, contentSize),
        );
        const shape = renderInverted ? invertMaskEdgeShape(growShape) : growShape;
        const field = this.renderLeafDistanceField(maskClip, contentSize);
        if (field) {
          this.distanceFieldRenderer.renderFromField(
            field.texture,
            perMaskRenderTexture,
            shape,
            field.band,
          );
        } else {
          this.renderMaskSubsetToTexture(
            new Set<string>([maskClip.id]),
            leafTexture,
            transform,
          );
          this.distanceFieldRenderer.render(leafTexture, perMaskRenderTexture, shape);
        }
        this.renderTextureToTarget(perMaskRenderTexture, leafTexture, {
          clear: true,
        });
        return;
      }

      if (!renderInverted) {
        this.renderMaskSubsetToTexture(
          new Set<string>([maskClip.id]),
          leafTexture,
          transform,
        );
        return;
      }

      if (!perMaskRenderTexture) {
        return;
      }
      this.renderMaskSubsetToTexture(
        new Set<string>([maskClip.id]),
        perMaskRenderTexture,
        transform,
      );
      this.renderTextureToTarget(perMaskRenderTexture, leafTexture, {
        clear: true,
        filters: [this.getMaskCoverageInvertFilter()],
      });
    });
  }

  /** Keep each leaf's sub-pixel edge through grow, inversion and booleans. */
  private renderLeafMaskFields(
    variants: readonly MaskBooleanLeafVariant[],
    maskClipByLocalId: Map<string, MaskTimelineClip>,
    contentSize: { width: number; height: number },
  ): Map<string, MaskFieldQuality> {
    const qualities = new Map<string, MaskFieldQuality>();
    const scratch = this.pool.getPerMaskRenderTexture();
    if (!scratch) return qualities;

    for (const variant of variants) {
      const key = getMaskBooleanLeafKey(variant.maskId, variant.inverted);
      const target = this.pool.getLeafMaskRenderTexture(key);
      const maskClip = maskClipByLocalId.get(variant.maskId);
      if (!target || !maskClip || !this.isMaskClipRenderable(maskClip)) continue;

      const inverted = maskClip.maskInverted !== variant.inverted;
      const growTexels =
        getSam2MaskGrowAmount(maskClip) * texelsPerContentPixel(target, contentSize);
      const field = this.renderLeafDistanceField(maskClip, contentSize);
      if (field && growTexels === 0 && field.band > 0) {
        // No offset or geometric distortion: keep the stored band verbatim.
        this.renderTextureToTarget(field.texture, target, {
          filters: inverted ? [this.getMaskCoverageInvertFilter()] : null,
        });
        qualities.set(key, { band: field.band, exactOutside: true });
        continue;
      }

      if (!field) {
        this.renderMaskSubsetToTexture(
          new Set([maskClip.id]),
          scratch,
          contentTransform(contentSize),
        );
      }
      this.distanceFieldRenderer.renderField(field?.texture ?? scratch, target, {
        sourceKind: field ? "field" : this.coverageSeedKind(maskClip),
        growTexels,
        inverted,
      });
      qualities.set(key, {
        band: resolveDistanceFieldBand(1),
        // Offsetting only preserves distances outside a grow / inside a
        // shrink. Inversion exchanges those sides; the final composite
        // re-distances whenever the shaping ramp needs the other side.
        exactOutside: inverted ? growTexels <= 0 : growTexels >= 0,
      });
    }
    return qualities;
  }

  private evaluateMaskBooleanExpression(
    expression: MaskBooleanExpression,
    operationTextureIndex: { current: number },
    compositeInvert: boolean,
    maskClipByLocalId: Map<string, MaskTimelineClip>,
    fieldQualities?: ReadonlyMap<string, MaskFieldQuality>,
  ): ResolvedMaskTexture | null {
    if (expression.kind === "mask_ref") {
      const texture = this.resolveRenderableLeafMaskTexture(
        expression.maskId,
        !!expression.inverted,
        maskClipByLocalId,
      );
      const field = fieldQualities?.get(
        getMaskBooleanLeafKey(expression.maskId, !!expression.inverted),
      );
      return texture && (!fieldQualities || field)
        ? { texture, field: field ?? null }
        : null;
    }

    const leftTexture = this.evaluateMaskBooleanExpression(
      expression.left,
      operationTextureIndex,
      compositeInvert,
      maskClipByLocalId,
      fieldQualities,
    );
    const rightTexture = this.evaluateMaskBooleanExpression(
      expression.right,
      operationTextureIndex,
      compositeInvert,
      maskClipByLocalId,
      fieldQualities,
    );
    const targetTexture =
      this.pool.getExpressionRenderTextures()[operationTextureIndex.current] ??
      null;
    operationTextureIndex.current += 1;

    if (!leftTexture || !rightTexture || !targetTexture) {
      return leftTexture ?? rightTexture ?? null;
    }

    this.renderMaskBooleanOperationToTarget(
      leftTexture.texture,
      rightTexture.texture,
      targetTexture,
      expression.operator,
      compositeInvert,
    );
    return {
      texture: targetTexture,
      field:
        leftTexture.field && rightTexture.field
          ? combineMaskFieldQuality(
              expression.operator,
              compositeInvert,
              leftTexture.field,
              rightTexture.field,
            )
          : null,
    };
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
    inverted: boolean,
    maskClipByLocalId: Map<string, MaskTimelineClip>,
  ): Texture | null {
    const maskClip = maskClipByLocalId.get(maskId);
    if (!maskClip || !this.isMaskClipRenderable(maskClip)) {
      return null;
    }

    return this.pool.getLeafMaskRenderTexture(
      getMaskBooleanLeafKey(maskId, inverted),
    );
  }

  /**
   * Shape a single-mask expression straight from that mask's distance band.
   * Returns null when the expression is not one distance-band mask with
   * edge ops, leaving it to the coverage pipeline.
   */
  private renderSingleLeafEdgeFromField(
    options: ResolveMaskCoverageOptions,
  ): Texture | null {
    const { expression, contentSize } = options;
    if (expression.kind !== "mask_ref") {
      return null;
    }
    const edgeOps = toMaskEdgeOps(options.compositeState);
    if (!hasMaskEdgeOps(edgeOps)) {
      return null;
    }
    const maskClip = options.maskClipByLocalId.get(expression.maskId);
    if (!maskClip || !this.isMaskClipRenderable(maskClip)) {
      return null;
    }
    const node = this.nodeRegistry.getAssetNode(maskClip.id);
    const target = this.pool.getEffectMaskRenderTexture();
    if (!node || node.decodeFilter.encoding !== "tsdf8_k8" || !target) {
      return null;
    }

    // Folding the mask's own grow into the edge ops must be exact; anything
    // else (a shrink then a grow, a feather across a grown edge) needs the
    // intermediate mask, which the coverage pipeline draws and re-distances.
    const texels = texelsPerContentPixel(target, contentSize);
    const stages = planMaskEdgeStages(edgeOps, texels);
    const shape =
      stages.length === 1
        ? composeMaskEdgeShapeOverLeaf(stages[0], {
            growTexels: getSam2MaskGrowAmount(maskClip) * texels,
            inverted: maskClip.maskInverted !== !!expression.inverted,
          })
        : null;
    if (!shape) {
      return null;
    }
    const field = this.renderLeafDistanceField(maskClip, contentSize);
    if (!field) {
      return null;
    }
    this.distanceFieldRenderer.renderFromField(
      field.texture,
      target,
      shape,
      field.band,
    );
    return target;
  }

  /**
   * Render a distance-band mask's band into the pool's field texture, in
   * content texels. Null for masks without one.
   */
  private renderLeafDistanceField(
    maskClip: MaskTimelineClip,
    contentSize: { width: number; height: number },
  ): { texture: Texture; band: number } | null {
    const node = this.nodeRegistry.getAssetNode(maskClip.id);
    if (!node || node.decodeFilter.encoding !== "tsdf8_k8") {
      return null;
    }
    this.pool.ensureFieldRenderTexture(contentSize);
    const fieldTexture = this.pool.getFieldRenderTexture();
    if (!fieldTexture) {
      return null;
    }
    this.renderMaskSubsetToTexture(
      new Set<string>([maskClip.id]),
      fieldTexture,
      contentTransform(contentSize),
      "distance_field",
    );
    // Off a similarity, or where the sprite leaves content uncovered, the
    // band's values are not content distances: shaping must re-distance
    // from its zero crossing, which a band of zero forces.
    const { distanceScale } = resolveNodeFieldGeometry(node, contentSize);
    return {
      texture: fieldTexture,
      band:
        distanceScale === null
          ? 0
          : resolveDistanceFieldBand(
              distanceScale * texelsPerContentPixel(fieldTexture, contentSize),
            ),
    };
  }

  private renderCompositeMaskEdgeTexture(
    sourceTexture: Texture,
    compositeState: ResolvedMaskCompositeState,
    contentSize: { width: number; height: number },
    field: MaskFieldQuality | null = null,
    sourceKind: "coverage" | "antialiased" = "antialiased",
  ): Texture {
    const edgeOps = toMaskEdgeOps(compositeState);
    if (!field && !hasMaskEdgeOps(edgeOps)) {
      return sourceTexture;
    }

    const target: RenderTexture | null = this.pool.getEffectMaskRenderTexture();
    const scratch = this.pool.getPerMaskRenderTexture();
    if (!target || !scratch || target === sourceTexture) {
      return sourceTexture;
    }

    const stages = planMaskEdgeStages(
      edgeOps,
      texelsPerContentPixel(sourceTexture, contentSize),
    );
    const firstTarget = stages.length === 1 ? target : scratch;
    if (field) {
      this.distanceFieldRenderer.renderFromField(
        sourceTexture,
        firstTarget,
        stages[0],
        canShapeMaskUnionFromField(stages[0], field) ? field.band : 0,
      );
    } else {
      this.distanceFieldRenderer.render(sourceTexture, firstTarget, stages[0], sourceKind);
    }
    if (stages.length === 1) {
      return target;
    }
    // Grow, then re-distance the grown mask for the feather.
    this.distanceFieldRenderer.render(scratch, target, stages[1], "antialiased");
    return target;
  }

  /** Stored bands and brush/vector rasters have already placed their AA edge. */
  private coverageSeedKind(maskClip: MaskTimelineClip): "coverage" | "antialiased" {
    if (maskClip.maskType === "generation") return "coverage";
    if (maskClip.maskType === "sam2") {
      return this.nodeRegistry.getAssetNode(maskClip.id)?.decodeFilter.encoding === "tsdf8_k8"
        ? "antialiased"
        : "coverage";
    }
    return "antialiased";
  }

  private renderTextureToTarget(
    sourceTexture: Texture,
    target: Texture,
    options: {
      clear?: boolean;
      filters?: Filter[] | null;
    } = {},
  ): void {
    const perMaskSprite = this.ensurePerMaskSprite();
    perMaskSprite.texture = sourceTexture;
    perMaskSprite.filters = options.filters ?? null;
    perMaskSprite.visible = true;

    this.renderer.render({
      container: perMaskSprite,
      target,
      clear: options.clear ?? true,
    });

    perMaskSprite.filters = null;
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

  private renderMaskSubsetToTexture(
    maskIds: Set<string>,
    target: Texture,
    transform: Matrix,
    assetOutput: MaskAssetDecodeOutput = "coverage",
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

    const contentSize = { width: target.width, height: target.height };
    this.nodeRegistry.assetMaskNodes.forEach((node, maskId) => {
      previousAssetVisibility.push({
        node,
        visible: node.root.visible,
      });
      node.root.visible =
        maskIds.has(maskId) &&
        node.player.sprite.visible &&
        this.hasUsableTexture(node.player.sprite);
      if (node.root.visible) {
        node.decodeFilter.setOutput(assetOutput);
        node.decodeFilter.setDistanceScale(
          resolveNodeFieldGeometry(node, contentSize).coverageScale *
            texelsPerContentPixel(target, contentSize),
        );
      }
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
        entry.node.decodeFilter.setOutput("coverage");
      });
    }
  }

  private isMaskClipRenderable(maskClip: MaskTimelineClip): boolean {
    const sprite = this.nodeRegistry.getAssetNode(maskClip.id)?.player.sprite;
    if (sprite) {
      return sprite.visible && this.hasUsableTexture(sprite);
    }

    return this.nodeRegistry.vectorMaskNodes.has(maskClip.id);
  }
}
