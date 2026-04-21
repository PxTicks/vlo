import {
  AlphaMask,
  BlurFilter,
  Container,
  type Filter,
  Graphics,
  Matrix,
  RenderTexture,
  Sprite,
  Texture,
} from "pixi.js";
import type { Renderer } from "pixi.js";
import type {
  MaskBooleanExpression,
  TimelineClip,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import type { Asset } from "../../../types/Asset";
import {
  applyClipTransforms,
  calculateClipTime,
} from "../../transformations";
import { dispatchTransform } from "../../transformations/catalogue/TransformationRegistry";
import type { TransformState } from "../../transformations/catalogue/types";
import { createMaskBinaryThresholdFilter } from "../../transformations/catalogue/mask/maskBinaryThresholdFilter";
import { createMaskCleanupFilter } from "../../transformations/catalogue/mask/maskCleanupFilter";
import {
  createMaskBooleanBlendFilter,
  type MaskBooleanBlendFilter,
} from "../../transformations/catalogue/mask/maskBooleanBlendFilter";
import { createMaskCoverageBoostFilter } from "../../transformations/catalogue/mask/maskCoverageBoostFilter";
import { createMaskCoverageInvertFilter } from "../../transformations/catalogue/mask/maskCoverageInvertFilter";
import { createMaskRedToAlphaFilter } from "../../transformations/catalogue/mask/maskRedToAlphaFilter";
import { drawMaskBaseShape } from "../model/maskFactory";
import type { MaskBooleanExpressionAnalysis } from "../model/maskBooleanExpression";
import {
  analyzeMaskBooleanExpression,
  collectUnionMaskIds,
  getMaskLocalId,
  resolveRenderableMaskBooleanExpression,
} from "../model/maskBooleanExpression";
import {
  calculatePlayerFrameTime,
  snapFrameTimeSeconds,
} from "../../renderer";
import { MaskVideoFramePlayer } from "./MaskVideoFramePlayer";

const MASK_EDGE_BLUR_SCALE = 0.5;
interface VectorMaskNode {
  root: Container;
  graphics: Graphics;
  spriteHost: Container;
  sprite: Sprite;
  shapeSignature: string;
  rasterSignature: string;
  rasterTexture: RenderTexture | null;
  rasterWidth: number;
  rasterHeight: number;
  presentation: "graphics" | "sprite";
}

interface AssetMaskNode {
  root: Container;
  player: MaskVideoFramePlayer;
  assetId: string;
  thresholdFilter: Filter;
}

type MaskApplicationMode = "none" | "regular" | "alpha";

interface ResolvedMaskCompositeState {
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

function getAssetBackedMaskId(maskClip: MaskTimelineClip): string | null {
  if (maskClip.maskType === "sam2") {
    return maskClip.sam2MaskAssetId ?? null;
  }
  if (maskClip.maskType === "generation") {
    return maskClip.generationMaskAssetId ?? null;
  }
  return null;
}

function isAssetBackedMask(maskClip: MaskTimelineClip): boolean {
  return getAssetBackedMaskId(maskClip) !== null;
}

function getMaskContentSize(clip: MaskTimelineClip): {
  width: number;
  height: number;
} {
  const params = clip.maskParameters;
  return {
    width: Math.max(1, params?.baseWidth ?? 1),
    height: Math.max(1, params?.baseHeight ?? 1),
  };
}

function getMaskShapeSignature(clip: MaskTimelineClip): string {
  return JSON.stringify({
    type: clip.maskType,
    baseWidth: clip.maskParameters?.baseWidth,
    baseHeight: clip.maskParameters?.baseHeight,
  });
}

function getMaskVideoSpriteContentSize(
  sprite: Sprite,
  fallback: { width: number; height: number },
): { width: number; height: number } {
  const texture = sprite.texture;
  if (
    texture &&
    texture !== Texture.EMPTY &&
    texture.width > 0 &&
    texture.height > 0
  ) {
    return { width: texture.width, height: texture.height };
  }
  return fallback;
}

/**
 * Manages mask application on a frame Sprite.
 *
 * When a PixiJS `Renderer` is provided, masks are composited into a
 * `RenderTexture` at the content's native resolution and applied via
 * AlphaMask's *direct-sprite* path (`renderMaskToTexture = false`).
 * This bypasses `AlphaMaskPipe`'s render-to-texture pipeline whose
 * `bounds.ceil()` rounding causes UV misalignment during viewport zoom.
 *
 * When no renderer is available (unit tests), falls back to the old
 * Container-based AlphaMask approach.
 */
export class SpriteClipMaskController {
  private readonly sprite: Sprite;
  private readonly maskContainer: Container;
  private readonly maskRootContainer: Container | null;
  private readonly maskTarget: Container;
  private readonly vectorMaskNodes = new Map<string, VectorMaskNode>();
  private readonly assetMaskNodes = new Map<string, AssetMaskNode>();

  // Renderer-based compositing (null = fallback to old approach)
  private readonly renderer: Renderer | null;
  private maskSprite: Sprite | null = null;
  private maskRenderTexture: RenderTexture | null = null;
  private perMaskRenderTexture: RenderTexture | null = null;
  private effectMaskRenderTexture: RenderTexture | null = null;
  private presentationMaskRenderTexture: RenderTexture | null = null;
  private leafMaskRenderTextures = new Map<string, RenderTexture>();
  private expressionRenderTextures: RenderTexture[] = [];
  private perMaskSprite: Sprite | null = null;
  private maskBooleanSprite: Sprite | null = null;
  private maskBooleanBlendFilters: Partial<
    Record<"union" | "intersect" | "subtract", MaskBooleanBlendFilter>
  > = {};
  private maskBinaryThresholdFilter: Filter | null = null;
  private maskCleanupFilter: Filter | null = null;
  private maskCoverageBoostFilter: Filter | null = null;
  private maskCoverageInvertFilter: Filter | null = null;
  private maskRedToAlphaFilter: Filter | null = null;
  private blurFilter: BlurFilter | null = null;

  private alphaMaskEffect: AlphaMask | null = null;
  private currentMaskMode: MaskApplicationMode = "none";
  private currentInverse = false;
  private lastContentWidth = 0;
  private lastContentHeight = 0;

  constructor(
    sprite: Sprite,
    renderer?: Renderer | null,
    maskRootContainer?: Container | null,
  ) {
    this.sprite = sprite;
    this.renderer = renderer ?? null;
    this.maskRootContainer = maskRootContainer ?? null;
    this.maskTarget = sprite as unknown as Container;
    this.maskContainer = new Container();

    // Keep mask nodes as siblings under a Container host (never under Sprite),
    // matching Pixi v8 scene-graph constraints.
    if (this.renderer) {
      // Renderer available: keep maskContainer in the track scene graph so
      // stencil-mask paths always have a valid root hierarchy.
      this.maskContainer.visible = false;

      // We still render maskContainer into a RenderTexture for alpha-mask paths.
      this.maskSprite = new Sprite();
      this.maskSprite.anchor.set(0.5);
      this.maskSprite.visible = false;
      this.maskSprite.renderable = false;
    }

    this.ensureMaskSceneNodesAttached();
    this.syncOutputModeVisibility();
  }

  /**
   * Sync masks from first-class mask TimelineClips.
   * Includes vector masks and asset-backed raster video masks.
   */
  public async syncMaskClips(
    maskClips: MaskTimelineClip[],
    parentClip: TimelineClip,
    logicalDimensions: { width: number; height: number },
    rawTimeTicks: number,
    assetsById: Map<string, Asset>,
    options: {
      fps?: number;
      waitForSam2?: boolean;
      skipSam2FrameRender?: boolean;
    } = {},
  ) {
    this.ensureMaskSceneNodesAttached();
    this.syncMaskSpriteTransform();

    const {
      fps,
      waitForSam2 = false,
      skipSam2FrameRender = false,
    } = options;
    const resolvedMaskExpression =
      parentClip.type === "mask"
        ? null
        : resolveRenderableMaskBooleanExpression(parentClip, maskClips);
    const resolvedMaskExpressionAnalysis = analyzeMaskBooleanExpression(
      resolvedMaskExpression,
    );
    const referencedMaskIds = new Set(
      resolvedMaskExpressionAnalysis.maskIds,
    );
    const referencedMaskClips = maskClips.filter((clip) => {
      const maskId = getMaskLocalId(clip);
      return !!maskId && referencedMaskIds.has(maskId);
    });
    const maskClipByLocalId = new Map<string, MaskTimelineClip>();
    referencedMaskClips.forEach((clip) => {
      const maskId = getMaskLocalId(clip);
      if (!maskId) {
        return;
      }
      maskClipByLocalId.set(maskId, clip);
    });

    // These legacy option names now gate all asset-backed mask video decoding.
    // Generation masks intentionally share the same render path as SAM2 masks.
    const activeMaskClips = referencedMaskClips.filter((clip) => {
      if (clip.maskMode !== "apply") return false;
      const assetMaskId = getAssetBackedMaskId(clip);
      return assetMaskId === null || assetsById.has(assetMaskId);
    });
    const activeVectorMasks = activeMaskClips.filter(
      (clip) =>
        !isAssetBackedMask(clip) &&
        clip.maskType !== "sam2" &&
        clip.maskType !== "generation",
    );
    const activeAssetMasks = activeMaskClips.filter((clip) =>
      isAssetBackedMask(clip),
    );

    this.reconcileVectorNodes(activeVectorMasks.map((clip) => clip.id));
    this.reconcileAssetMaskNodes(
      activeAssetMasks.map((clip) => ({
        maskId: clip.id,
        assetId: getAssetBackedMaskId(clip) as string,
      })),
    );

    if (!resolvedMaskExpression || referencedMaskIds.size === 0) {
      this.clear();
      return;
    }

    if (activeMaskClips.length === 0) {
      this.clear();
      return;
    }

    activeVectorMasks.forEach((maskClip) => {
      const node = this.vectorMaskNodes.get(maskClip.id);
      if (!node) return;
      node.root.visible = true;

      const maskContentSize = getMaskContentSize(maskClip);
      const shapeSignature = getMaskShapeSignature(maskClip);
      if (node.shapeSignature !== shapeSignature) {
        node.graphics.clear();
        drawMaskBaseShape(node.graphics, maskClip);
        node.shapeSignature = shapeSignature;
      }

      if (this.shouldRasterizeVectorMask(maskClip)) {
        // Reserved for any future vector-mask path that truly needs a local
        // raster sprite before entering the shared composite pipeline.
        this.setVectorMaskPresentation(node, "sprite");
        this.syncVectorMaskSprite(node, maskContentSize);
        applyClipTransforms(
          node.sprite,
          maskClip,
          logicalDimensions,
          rawTimeTicks,
          maskContentSize,
          { baseLayoutMode: "origin", notifyLiveParams: false },
        );
      } else {
        this.setVectorMaskPresentation(node, "graphics");
        applyClipTransforms(
          node.graphics,
          maskClip,
          logicalDimensions,
          rawTimeTicks,
          maskContentSize,
          { baseLayoutMode: "origin", notifyLiveParams: false },
        );
      }
    });

    const globalTimeTicks = parentClip.start + rawTimeTicks;
    const maskInputTimeSeconds = calculatePlayerFrameTime(
      parentClip,
      globalTimeTicks,
    );
    const requestedMaskTimeSeconds =
      typeof fps === "number" && Number.isFinite(fps) && fps > 0
        ? snapFrameTimeSeconds(maskInputTimeSeconds, fps)
        : maskInputTimeSeconds;
    const clipContentSize = this.getActiveClipContentSize(logicalDimensions);

    for (const maskClip of activeAssetMasks) {
      const maskAssetId = getAssetBackedMaskId(maskClip);
      if (!maskAssetId) continue;
      const asset = assetsById.get(maskAssetId);
      const node = this.assetMaskNodes.get(maskClip.id);
      if (!asset || !node) continue;
      node.root.visible = true;

      if (node.assetId !== asset.id) {
        node.assetId = asset.id;
        await node.player.setSource(asset);
      } else {
        await node.player.setSource(asset);
      }

      if (!skipSam2FrameRender) {
        if (waitForSam2) {
          await node.player.renderAt(requestedMaskTimeSeconds, {
            strict: true,
          });
        } else {
          void node.player
            .renderAt(requestedMaskTimeSeconds)
            .catch((error) => {
              console.warn("Mask video frame update failed", error);
            });
        }
      }

      const maskSprite = node.player.sprite;
      const maskSize = getMaskVideoSpriteContentSize(maskSprite, clipContentSize);
      applyClipTransforms(
        maskSprite,
        maskClip,
        logicalDimensions,
        rawTimeTicks,
        maskSize,
        { baseLayoutMode: "origin", notifyLiveParams: false },
      );
    }

    const singleMask = activeMaskClips.length === 1 ? activeMaskClips[0] : null;
    const sharedMaskCompositeState = this.resolveMaskCompositeState(
      parentClip,
      logicalDimensions,
      clipContentSize,
      rawTimeTicks,
    );
    const hasSharedEdgeOps =
      sharedMaskCompositeState.growAmount > 0 ||
      (sharedMaskCompositeState.feather?.amount ?? 0) > 0;
    const hasCompositeInvert = sharedMaskCompositeState.compositeInvert;
    const hasInvertedMask = activeMaskClips.some((maskClip) => maskClip.maskInverted);
    const simpleUnionMasks =
      hasSharedEdgeOps || hasCompositeInvert
        ? null
        : this.resolveSimpleUnionMaskClips(
          resolvedMaskExpression,
          maskClipByLocalId,
        );
    const shouldUseCompositedAlphaMask =
      this.renderer !== null &&
      (hasSharedEdgeOps || hasCompositeInvert || simpleUnionMasks === null);
    this.sanitizeAssetMaskSpriteVisibility();

    if (this.maskSprite && shouldUseCompositedAlphaMask) {
      const hasReadyAssetMask = activeAssetMasks.some((maskClip) => {
        const node = this.assetMaskNodes.get(maskClip.id);
        if (!node) return false;
        return (
          node.player.sprite.visible && this.hasUsableTexture(node.player.sprite)
        );
      });

      // Preserve prior behavior: when only asset-backed masks are active but no
      // decoded frame is ready yet, render unmasked until first frame arrives.
      if (
        (activeVectorMasks.length > 0 || hasReadyAssetMask) &&
        this.hasRenderableContentTexture()
      ) {
        const renderedTexture = this.renderMaskBooleanExpressionToTexture(
          resolvedMaskExpression,
          resolvedMaskExpressionAnalysis,
          maskClipByLocalId,
          clipContentSize,
          sharedMaskCompositeState,
        );
        if (renderedTexture) {
          this.applyAlphaMask(this.maskSprite, false);
        } else {
          this.removeMaskFromTarget();
        }
      } else {
        this.removeMaskFromTarget();
      }
    } else if (simpleUnionMasks) {
      const inverse = false;
      this.applyMaskEffect(this.maskContainer, inverse, false);
    } else if (
      activeAssetMasks.length > 0 ||
      hasInvertedMask ||
      hasSharedEdgeOps ||
      hasCompositeInvert
    ) {
      // No renderer / no maskSprite (test fallback): Container-based AlphaMask
      const inverse = singleMask ? (singleMask.maskInverted ?? false) : false;
      this.applyMaskEffect(this.maskContainer, inverse, true);
    } else {
      // Vector-only: stencil mask
      const inverse = singleMask ? (singleMask.maskInverted ?? false) : false;
      this.applyMaskEffect(this.maskContainer, inverse, false);
    }
  }

  public clear() {
    this.vectorMaskNodes.forEach((node) => {
      node.graphics.clear();
      node.shapeSignature = "";
      node.rasterSignature = "";
      node.root.visible = false;
      node.sprite.visible = false;
      node.spriteHost.visible = false;
    });
    this.assetMaskNodes.forEach((node) => {
      node.player.sprite.visible = false;
      node.root.visible = false;
    });
    this.removeMaskFromTarget();
    if (this.renderer) {
      this.maskContainer.visible = false;
    }
    if (this.maskSprite) {
      this.maskSprite.visible = false;
    }
    if (this.perMaskSprite) {
      this.perMaskSprite.blendMode = "normal";
      this.perMaskSprite.filters = null;
    }
    this.syncOutputModeVisibility();
  }

  public dispose() {
    this.clear();
    this.detachAlphaMaskEffect();
    this.alphaMaskEffect?.destroy();
    this.alphaMaskEffect = null;

    this.vectorMaskNodes.forEach((node) => {
      if (node.rasterTexture) {
        node.rasterTexture.destroy(true);
        node.rasterTexture = null;
      }
      if (node.root.parent) {
        node.root.removeFromParent();
      }
      if (!node.root.destroyed) {
        node.root.destroy({ children: true });
      }
    });
    this.vectorMaskNodes.clear();

    this.assetMaskNodes.forEach((node) => {
      if (node.root.parent) {
        node.root.removeFromParent();
      }
      node.player.dispose();
      if (!node.root.destroyed) {
        node.root.destroy({ children: false });
      }
    });
    this.assetMaskNodes.clear();

    if (this.maskRenderTexture) {
      this.maskRenderTexture.destroy(true);
      this.maskRenderTexture = null;
    }
    if (this.perMaskRenderTexture) {
      this.perMaskRenderTexture.destroy(true);
      this.perMaskRenderTexture = null;
    }
    if (this.effectMaskRenderTexture) {
      this.effectMaskRenderTexture.destroy(true);
      this.effectMaskRenderTexture = null;
    }
    if (this.presentationMaskRenderTexture) {
      this.presentationMaskRenderTexture.destroy(true);
      this.presentationMaskRenderTexture = null;
    }
    this.leafMaskRenderTextures.forEach((texture) => {
      texture.destroy(true);
    });
    this.leafMaskRenderTextures.clear();
    this.expressionRenderTextures.forEach((texture) => {
      texture.destroy(true);
    });
    this.expressionRenderTextures = [];

    if (this.maskSprite) {
      if (this.maskSprite.parent) {
        this.maskSprite.removeFromParent();
      }
      if (!this.maskSprite.destroyed) {
        this.maskSprite.destroy();
      }
      this.maskSprite = null;
    }
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
    this.maskBooleanBlendFilters = {};
    this.maskBinaryThresholdFilter?.destroy();
    this.maskBinaryThresholdFilter = null;
    this.maskCleanupFilter?.destroy();
    this.maskCleanupFilter = null;
    this.maskCoverageBoostFilter?.destroy();
    this.maskCoverageBoostFilter = null;
    this.maskCoverageInvertFilter?.destroy();
    this.maskCoverageInvertFilter = null;
    this.maskRedToAlphaFilter?.destroy();
    this.maskRedToAlphaFilter = null;
    this.blurFilter?.destroy();
    this.blurFilter = null;

    if (this.maskContainer.parent) {
      this.maskContainer.removeFromParent();
    }
    if (!this.maskContainer.destroyed) {
      this.maskContainer.destroy({ children: true });
    }
  }

  // ── Private: mask compositing ──────────────────────────────────────

  private resolveMaskHostContainer(): Container | null {
    const host = this.maskRootContainer ?? this.maskTarget;
    if (host && typeof host.addChild === "function") {
      return host;
    }
    return null;
  }

  private ensureMaskSceneNodesAttached() {
    const host = this.resolveMaskHostContainer();
    if (!host) return;

    if (this.maskContainer.parent !== host) {
      if (this.maskContainer.parent) {
        this.maskContainer.removeFromParent();
      }
      host.addChild(this.maskContainer);
    }

    if (this.maskSprite && this.maskSprite.parent !== host) {
      if (this.maskSprite.parent) {
        this.maskSprite.removeFromParent();
      }
      host.addChild(this.maskSprite);
    }
  }

  public syncMaskSpriteTransform() {
    if (!this.maskSprite) return;
    const copyPoint = (
      target:
        | { x: number; y: number; copyFrom?: (src: { x: number; y: number }) => void }
        | undefined,
      src: { x: number; y: number } | undefined,
    ) => {
      if (!target || !src) return;
      if (typeof target.copyFrom === "function") {
        target.copyFrom(src);
      } else {
        target.x = src.x;
        target.y = src.y;
      }
    };
    copyPoint(this.maskSprite.anchor, this.sprite.anchor);
    copyPoint(this.maskSprite.pivot, this.sprite.pivot);

    const maskPosition = this.maskSprite.position as {
      x: number;
      y: number;
      set?: (x: number, y: number) => void;
    };
    if (typeof maskPosition.set === "function") {
      maskPosition.set(this.sprite.position.x, this.sprite.position.y);
    } else {
      maskPosition.x = this.sprite.position.x;
      maskPosition.y = this.sprite.position.y;
    }

    const maskScale = this.maskSprite.scale as {
      x: number;
      y: number;
      set?: (x: number, y?: number) => void;
    };
    if (typeof maskScale.set === "function") {
      maskScale.set(this.sprite.scale.x, this.sprite.scale.y);
    } else {
      maskScale.x = this.sprite.scale.x;
      maskScale.y = this.sprite.scale.y;
    }

    this.maskSprite.rotation = this.sprite.rotation;
    this.maskSprite.alpha = this.sprite.alpha;
  }

  private resolveMaskCompositeState(
    parentClip: TimelineClip,
    logicalDimensions: { width: number; height: number },
    contentSize: { width: number; height: number },
    rawTimeTicks: number,
  ): ResolvedMaskCompositeState {
    if (parentClip.type === "mask") {
      return {
        compositeInvert: false,
        growAmount: 0,
        growInvert: false,
        feather: null,
      };
    }

    const composition = (parentClip.components ?? []).find(
      (component) => component.type === "mask_composition",
    );
    const transforms =
      composition?.type === "mask_composition"
        ? composition.parameters.compositeTransformations
        : [];
    if (transforms.length === 0) {
      return {
        compositeInvert: false,
        growAmount: 0,
        growInvert: false,
        feather: null,
      };
    }

    const state: TransformState = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      filters: [],
    };
    const transformTime = calculateClipTime(parentClip, rawTimeTicks, true);

    transforms.forEach((transform) => {
      if (!transform.isEnabled) return;
      dispatchTransform(state, transform, {
        container: logicalDimensions,
        content: contentSize,
        time: transformTime,
      });
    });

    const compositeInvert = transforms.some(
      (transform) => transform.parameters.invert === true,
    );

    return {
      compositeInvert,
      growAmount: state.maskGrow?.amount ?? 0,
      growInvert: state.maskGrow?.invert ?? false,
      feather: state.feather ?? null,
    };
  }

  private resolveSimpleUnionMaskClips(
    expression: MaskBooleanExpression | null,
    maskClipByLocalId: Map<string, MaskTimelineClip>,
  ): MaskTimelineClip[] | null {
    const unionMaskIds = collectUnionMaskIds(expression);
    if (!unionMaskIds || unionMaskIds.length === 0) {
      return null;
    }

    const masks: MaskTimelineClip[] = [];
    for (const maskId of unionMaskIds) {
      const maskClip = maskClipByLocalId.get(maskId);
      if (!maskClip) {
        return null;
      }
      if (
        maskClip.maskMode !== "apply" ||
        maskClip.maskInverted ||
        isAssetBackedMask(maskClip) ||
        !this.isMaskClipRenderable(maskClip)
      ) {
        return null;
      }
      masks.push(maskClip);
    }

    return masks;
  }

  private renderLeafMaskTextures(
    referencedMaskIds: string[],
    maskClipByLocalId: Map<string, MaskTimelineClip>,
    contentSize: { width: number; height: number },
  ) {
    if (!this.renderer || !this.perMaskRenderTexture) {
      return;
    }
    const perMaskRenderTexture = this.perMaskRenderTexture;

    const transform = new Matrix().translate(
      contentSize.width / 2,
      contentSize.height / 2,
    );

    referencedMaskIds.forEach((maskId) => {
      const leafTexture = this.leafMaskRenderTextures.get(maskId);
      if (!leafTexture) {
        return;
      }

      const maskClip = maskClipByLocalId.get(maskId);
      if (
        !maskClip ||
        maskClip.maskMode !== "apply" ||
        !this.isMaskClipRenderable(maskClip)
      ) {
        this.renderMaskSubsetToTexture(new Set<string>(), leafTexture, transform);
        return;
      }

      if (!maskClip.maskInverted) {
        this.renderMaskSubsetToTexture(
          new Set<string>([maskClip.id]),
          leafTexture,
          transform,
        );
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

  private evaluateMaskBooleanExpression(
    expression: MaskBooleanExpression,
    operationTextureIndex: { current: number },
    compositeInvert: boolean,
  ): Texture | null {
    if (expression.kind === "mask_ref") {
      return this.leafMaskRenderTextures.get(expression.maskId) ?? null;
    }

    const leftTexture = this.evaluateMaskBooleanExpression(
      expression.left,
      operationTextureIndex,
      compositeInvert,
    );
    const rightTexture = this.evaluateMaskBooleanExpression(
      expression.right,
      operationTextureIndex,
      compositeInvert,
    );
    const targetTexture =
      this.expressionRenderTextures[operationTextureIndex.current];
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
    targetTexture: RenderTexture,
    operator: "union" | "intersect" | "subtract",
    compositeInvert: boolean,
  ) {
    if (!this.renderer) {
      return;
    }

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

  private renderMaskBooleanExpressionToTexture(
    expression: MaskBooleanExpression,
    expressionAnalysis: MaskBooleanExpressionAnalysis,
    maskClipByLocalId: Map<string, MaskTimelineClip>,
    contentSize: { width: number; height: number },
    compositeState: ResolvedMaskCompositeState,
  ): Texture | null {
    if (!this.renderer) {
      return null;
    }

    const referencedMaskIds = expressionAnalysis.maskIds;
    if (referencedMaskIds.length === 0) {
      return null;
    }

    this.ensureMaskRenderTexture(contentSize);
    this.ensurePerMaskRenderTexture(contentSize);
    this.ensureEffectMaskRenderTexture(contentSize);
    this.ensurePresentationMaskRenderTexture(contentSize);
    this.reconcileLeafMaskRenderTextures(referencedMaskIds, contentSize);
    this.ensureExpressionRenderTextureCount(
      expressionAnalysis.operationCount,
      contentSize,
    );

    if (!this.maskRenderTexture || !this.perMaskRenderTexture) {
      return null;
    }

    this.renderLeafMaskTextures(referencedMaskIds, maskClipByLocalId, contentSize);
    const evaluatedTexture = this.evaluateMaskBooleanExpression(expression, {
      current: 0,
    }, compositeState.compositeInvert);
    if (!evaluatedTexture) {
      return null;
    }

    const effectTexture = this.renderCompositeMaskEdgeTexture(
      evaluatedTexture,
      compositeState,
    );
    this.renderPresentedMaskTexture(effectTexture, contentSize);
    this.syncOutputModeVisibility();
    return effectTexture;
  }

  private renderCompositeMaskEdgeTexture(
    sourceTexture: Texture,
    compositeState: ResolvedMaskCompositeState,
  ): Texture {
    if (
      !this.effectMaskRenderTexture ||
      !this.perMaskRenderTexture ||
      !this.maskRenderTexture
    ) {
      return sourceTexture;
    }

    const feather = compositeState.feather;
    const hasEdgeOps =
      compositeState.growAmount > 0 || (feather?.amount ?? 0) > 0;
    if (!hasEdgeOps) {
      return sourceTexture;
    }

    this.renderThresholdPass(sourceTexture, this.effectMaskRenderTexture);

    let currentTexture: Texture = this.effectMaskRenderTexture;
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
  ) {
    if (!this.maskSprite) {
      return;
    }

    this.ensurePresentationMaskRenderTexture(contentSize);
    if (!this.presentationMaskRenderTexture) {
      return;
    }

    this.renderTextureToTarget(sourceTexture, this.presentationMaskRenderTexture, {
      clear: true,
      filters: [this.getMaskRedToAlphaFilter()],
    });
    this.maskSprite.texture = this.presentationMaskRenderTexture;
  }

  private renderBlurPass(
    sourceTexture: Texture,
    target: RenderTexture,
    amount: number,
    options: {
      boost?: boolean;
    } = {},
  ) {
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

  private renderThresholdPass(sourceTexture: Texture, target: RenderTexture) {
    this.renderTextureToTarget(sourceTexture, target, {
      clear: true,
      filters: [this.getMaskBinaryThresholdFilter()],
    });
  }

  private renderCoverageInvertPass(
    sourceTexture: Texture,
    target: RenderTexture,
  ) {
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
    if (!this.effectMaskRenderTexture || !this.perMaskRenderTexture) {
      return sourceTexture;
    }

    if (!invert) {
      this.renderBlurPass(sourceTexture, this.perMaskRenderTexture, amount, {
        boost: true,
      });
      this.renderThresholdPass(
        this.perMaskRenderTexture,
        this.effectMaskRenderTexture,
      );
      return this.effectMaskRenderTexture;
    }

    this.renderCoverageInvertPass(sourceTexture, this.perMaskRenderTexture);
    this.renderBlurPass(
      this.perMaskRenderTexture,
      this.effectMaskRenderTexture,
      amount,
      { boost: true },
    );
    this.renderThresholdPass(
      this.effectMaskRenderTexture,
      this.perMaskRenderTexture,
    );
    this.renderCoverageInvertPass(
      this.perMaskRenderTexture,
      this.effectMaskRenderTexture,
    );
    return this.effectMaskRenderTexture;
  }

  private renderFeatherPass(
    sourceTexture: Texture,
    feather: NonNullable<ResolvedMaskCompositeState["feather"]>,
  ): Texture {
    if (
      !this.effectMaskRenderTexture ||
      !this.perMaskRenderTexture ||
      !this.maskRenderTexture
    ) {
      return sourceTexture;
    }

    if (!feather.invert) {
      return this.renderFeatherPassInCurrentSpace(sourceTexture, feather);
    }

    const invertedInputTarget = this.getAlternateEffectTarget(sourceTexture);
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
    const finalTarget = this.getAlternateEffectTarget(invertedResult);
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
    const outputTarget = this.getAlternateEffectTarget(sourceTexture);
    if (!outputTarget || !this.effectMaskRenderTexture || !this.perMaskRenderTexture) {
      return sourceTexture;
    }

    if (feather.mode === "two_way") {
      this.renderBlurPass(
        sourceTexture,
        this.perMaskRenderTexture,
        feather.amount,
        { boost: true },
      );
      this.renderTextureToTarget(this.perMaskRenderTexture, outputTarget, {
        clear: true,
      });
      this.renderTextureToTarget(sourceTexture, outputTarget, {
        clear: false,
      });
      const finalBlurTarget = this.getAlternateEffectTarget(outputTarget);
      if (!finalBlurTarget) {
        return outputTarget;
      }
      this.renderBlurPass(
        outputTarget,
        finalBlurTarget,
        feather.amount,
      );
      return finalBlurTarget;
    }

    this.renderBlurPass(
      sourceTexture,
      this.perMaskRenderTexture,
      feather.amount,
      { boost: feather.mode === "hard_outer" },
    );

    if (feather.mode === "soft_inner") {
      this.renderTextureToTarget(sourceTexture, outputTarget, {
        clear: true,
      });
      this.renderTextureToTarget(this.perMaskRenderTexture, outputTarget, {
        clear: false,
        blendMode: "multiply",
      });
      return outputTarget;
    }

    this.renderTextureToTarget(this.perMaskRenderTexture, outputTarget, {
      clear: true,
    });
    this.renderTextureToTarget(sourceTexture, outputTarget, {
      clear: false,
    });
    return outputTarget;
  }

  private renderTextureToTarget(
    sourceTexture: Texture,
    target: RenderTexture,
    options: {
      clear?: boolean;
      blendMode?: Sprite["blendMode"];
      filters?: Filter[] | null;
    } = {},
  ) {
    if (!this.renderer || !this.perMaskSprite) return;

    this.perMaskSprite.texture = sourceTexture;
    this.perMaskSprite.filters = options.filters ?? null;
    this.perMaskSprite.blendMode = options.blendMode ?? "normal";
    this.perMaskSprite.visible = true;

    this.renderer.render({
      container: this.perMaskSprite,
      target,
      clear: options.clear ?? true,
    });

    this.perMaskSprite.filters = null;
    this.perMaskSprite.blendMode = "normal";
  }

  /**
   * Apply the composited maskSprite as an AlphaMask on the frame sprite.
   * Since maskSprite is a Sprite, AlphaMask uses the direct-sprite path
   * (`renderMaskToTexture = false`) — no intermediate texture or bounds
   * rounding by AlphaMaskPipe.
   */
  private applyAlphaMask(target: Sprite, inverse: boolean) {
    const previousMode = this.currentMaskMode;

    if (previousMode === "regular") {
      this.setMaskOnTarget(null, false);
    }

    const targetChanged =
      this.alphaMaskEffect && this.alphaMaskEffect.mask !== target;

    if (
      this.currentMaskMode !== "alpha" ||
      this.currentInverse !== inverse ||
      targetChanged
    ) {
      if (previousMode === "alpha") {
        this.detachAlphaMaskEffect();
      }

      // (Re)create AlphaMask if the target sprite changed
      if (!this.alphaMaskEffect || this.alphaMaskEffect.mask !== target) {
        this.alphaMaskEffect?.destroy();
        this.alphaMaskEffect = new AlphaMask({ mask: target });
      }

      this.alphaMaskEffect.inverse = inverse;
      this.attachAlphaMaskEffect();
      this.currentMaskMode = "alpha";
      this.currentInverse = inverse;
    }
    this.syncOutputModeVisibility();
  }

  // ── Private: fallback mask application (no renderer) ───────────────

  private applyMaskEffect(
    mask: Container | null,
    inverse: boolean,
    useAlphaMask: boolean,
  ) {
    const previousMode = this.currentMaskMode;
    const nextMode: MaskApplicationMode =
      mask === null ? "none" : useAlphaMask ? "alpha" : "regular";

    if (
      this.currentMaskMode === nextMode &&
      this.currentInverse === inverse
    ) {
      return;
    }

    if (previousMode === "alpha") {
      this.detachAlphaMaskEffect();
    }

    this.currentMaskMode = nextMode;
    this.currentInverse = inverse;

    if (!mask) {
      this.removeMaskFromTarget();
      return;
    }

    if (nextMode === "regular") {
      this.syncOutputModeVisibility();
      this.setMaskOnTarget(mask, inverse);
      return;
    }

    if (nextMode === "alpha") {
      if (previousMode === "regular") {
        this.setMaskOnTarget(null, false);
      }

      if (!this.alphaMaskEffect || this.alphaMaskEffect.mask !== mask) {
        this.alphaMaskEffect?.destroy();
        this.alphaMaskEffect = new AlphaMask({ mask });
      }
      this.alphaMaskEffect.inverse = inverse;
      this.attachAlphaMaskEffect();
      this.syncOutputModeVisibility();
    }
  }

  // ── Private: scene graph helpers ───────────────────────────────────

  private createVectorMaskSpriteHost(
    texture: RenderTexture | null,
  ): Pick<VectorMaskNode, "spriteHost" | "sprite"> {
    const spriteHost = new Container();
    const sprite = new Sprite(texture ?? Texture.EMPTY);
    sprite.anchor.set(0.5);
    sprite.visible = false;
    spriteHost.visible = false;
    spriteHost.addChild(sprite);

    return { spriteHost, sprite };
  }

  private shouldRasterizeVectorMask(maskClip: MaskTimelineClip): boolean {
    void maskClip;
    return false;
  }

  private setVectorMaskPresentation(
    node: VectorMaskNode,
    presentation: VectorMaskNode["presentation"],
  ) {
    if (node.presentation === presentation) return;

    node.presentation = presentation;
    node.graphics.visible = presentation === "graphics";
    node.spriteHost.visible = presentation === "sprite";
    if (presentation === "graphics") {
      node.sprite.visible = false;
    }
  }

  private syncVectorMaskSprite(
    node: VectorMaskNode,
    contentSize: { width: number; height: number },
  ) {
    if (!this.renderer) return;

    const textureChanged = this.ensureVectorMaskRenderTexture(node, contentSize);
    if (!node.rasterTexture) return;

    if (textureChanged || node.rasterSignature !== node.shapeSignature) {
      // The source Graphics may have been used directly on prior frames, so
      // reset it back to the canonical base shape before rasterizing.
      const graphicsPosition = node.graphics.position as {
        x: number;
        y: number;
        set?: (x: number, y: number) => void;
      };
      if (typeof graphicsPosition.set === "function") {
        graphicsPosition.set(0, 0);
      } else {
        graphicsPosition.x = 0;
        graphicsPosition.y = 0;
      }

      const graphicsScale = node.graphics.scale as {
        x: number;
        y: number;
        set?: (x: number, y?: number) => void;
      };
      if (typeof graphicsScale.set === "function") {
        graphicsScale.set(1, 1);
      } else {
        graphicsScale.x = 1;
        graphicsScale.y = 1;
      }

      node.graphics.rotation = 0;
      (
        node.graphics as Graphics & {
          filters?: readonly unknown[] | unknown[] | null;
        }
      ).filters = null;

      const previousGraphicsVisibility = node.graphics.visible;
      node.graphics.visible = true;
      try {
        const transform = new Matrix().translate(
          contentSize.width / 2,
          contentSize.height / 2,
        );
        this.renderer.render({
          container: node.graphics,
          target: node.rasterTexture,
          clear: true,
          transform,
        });
        node.rasterSignature = node.shapeSignature;
      } finally {
        node.graphics.visible = previousGraphicsVisibility;
      }
    }

    if (node.sprite.texture !== node.rasterTexture) {
      node.sprite.texture = node.rasterTexture;
    }
    node.sprite.visible = true;
    node.spriteHost.visible = true;
  }

  private reconcileVectorNodes(maskIds: string[]) {
    const wanted = new Set(maskIds);
    this.vectorMaskNodes.forEach((node, maskId) => {
      if (wanted.has(maskId)) return;
      if (node.rasterTexture) {
        node.rasterTexture.destroy(true);
        node.rasterTexture = null;
      }
      if (node.root.parent) {
        node.root.removeFromParent();
      }
      if (!node.root.destroyed) {
        node.root.destroy({ children: true });
      }
      this.vectorMaskNodes.delete(maskId);
    });

    maskIds.forEach((maskId) => {
      if (this.vectorMaskNodes.has(maskId)) return;
      const root = new Container();
      const graphics = new Graphics();
      const { spriteHost, sprite } = this.createVectorMaskSpriteHost(null);
      root.addChild(graphics);
      root.addChild(spriteHost);
      this.maskContainer.addChild(root);
      this.vectorMaskNodes.set(maskId, {
        root,
        graphics,
        spriteHost,
        sprite,
        shapeSignature: "",
        rasterSignature: "",
        rasterTexture: null,
        rasterWidth: 0,
        rasterHeight: 0,
        presentation: "graphics",
      });
    });
  }

  private reconcileAssetMaskNodes(
    entries: Array<{ maskId: string; assetId: string }>,
  ) {
    const wantedMaskIds = new Set(entries.map((entry) => entry.maskId));
    this.assetMaskNodes.forEach((node, maskId) => {
      if (wantedMaskIds.has(maskId)) return;
      if (node.root.parent) {
        node.root.removeFromParent();
      }
      node.thresholdFilter.destroy();
      node.player.dispose();
      if (!node.root.destroyed) {
        node.root.destroy({ children: false });
      }
      this.assetMaskNodes.delete(maskId);
    });

    entries.forEach((entry) => {
      const existing = this.assetMaskNodes.get(entry.maskId);
      if (existing) return;
      const root = new Container();
      const player = new MaskVideoFramePlayer(entry.maskId);
      const thresholdFilter = createMaskBinaryThresholdFilter();
      player.sprite.filters = [thresholdFilter];
      root.addChild(player.sprite);
      this.maskContainer.addChild(root);
      this.assetMaskNodes.set(entry.maskId, {
        root,
        player,
        assetId: entry.assetId,
        thresholdFilter,
      });
    });
  }

  private getActiveClipContentSize(logicalDimensions: {
    width: number;
    height: number;
  }): { width: number; height: number } {
    const texture = this.sprite.texture;
    if (
      texture &&
      texture !== Texture.EMPTY &&
      texture.width > 0 &&
      texture.height > 0
    ) {
      return {
        width: texture.width,
        height: texture.height,
      };
    }
    return logicalDimensions;
  }

  private ensureMaskRenderTexture(contentSize: { width: number; height: number }) {
    const { width, height } = contentSize;
    if (
      !this.maskRenderTexture ||
      this.lastContentWidth !== width ||
      this.lastContentHeight !== height
    ) {
      if (this.maskRenderTexture) {
        this.maskRenderTexture.resize(width, height);
      } else {
        this.maskRenderTexture = RenderTexture.create({
          width,
          height,
          dynamic: true,
        });
      }
      this.lastContentWidth = width;
      this.lastContentHeight = height;
    }
  }

  private ensureVectorMaskRenderTexture(
    node: VectorMaskNode,
    contentSize: { width: number; height: number },
  ): boolean {
    const { width, height } = contentSize;
    let textureChanged = false;

    if (!node.rasterTexture) {
      node.rasterTexture = RenderTexture.create({
        width,
        height,
        dynamic: true,
      });
      textureChanged = true;
    } else if (node.rasterWidth !== width || node.rasterHeight !== height) {
      node.rasterTexture.resize(width, height);
      textureChanged = true;
    }

    node.rasterWidth = width;
    node.rasterHeight = height;
    return textureChanged;
  }

  private ensurePerMaskRenderTexture(contentSize: { width: number; height: number }) {
    const { width, height } = contentSize;
    if (!this.perMaskRenderTexture) {
      this.perMaskRenderTexture = RenderTexture.create({
        width,
        height,
        dynamic: true,
      });
    } else if (
      this.perMaskRenderTexture.width !== width ||
      this.perMaskRenderTexture.height !== height
    ) {
      this.perMaskRenderTexture.resize(width, height);
    }

    if (!this.perMaskSprite) {
      this.perMaskSprite = new Sprite();
      this.perMaskSprite.anchor.set(0);
    }
  }

  private ensureMaskBooleanSprite(): Sprite {
    if (!this.maskBooleanSprite) {
      this.maskBooleanSprite = new Sprite(Texture.WHITE);
      this.maskBooleanSprite.anchor.set(0);
    }

    return this.maskBooleanSprite;
  }

  private ensureEffectMaskRenderTexture(contentSize: {
    width: number;
    height: number;
  }) {
    const { width, height } = contentSize;
    if (!this.effectMaskRenderTexture) {
      this.effectMaskRenderTexture = RenderTexture.create({
        width,
        height,
        dynamic: true,
      });
    } else if (
      this.effectMaskRenderTexture.width !== width ||
      this.effectMaskRenderTexture.height !== height
    ) {
      this.effectMaskRenderTexture.resize(width, height);
    }
  }

  private ensurePresentationMaskRenderTexture(contentSize: {
    width: number;
    height: number;
  }) {
    if (!this.maskSprite) return;
    const { width, height } = contentSize;
    if (!this.presentationMaskRenderTexture) {
      this.presentationMaskRenderTexture = RenderTexture.create({
        width,
        height,
        dynamic: true,
      });
    } else if (
      this.presentationMaskRenderTexture.width !== width ||
      this.presentationMaskRenderTexture.height !== height
    ) {
      this.presentationMaskRenderTexture.resize(width, height);
    }

    this.maskSprite.texture = this.presentationMaskRenderTexture;
  }

  private reconcileLeafMaskRenderTextures(
    maskIds: string[],
    contentSize: { width: number; height: number },
  ) {
    const wantedMaskIds = new Set(maskIds);

    this.leafMaskRenderTextures.forEach((texture, maskId) => {
      if (wantedMaskIds.has(maskId)) {
        if (
          texture.width !== contentSize.width ||
          texture.height !== contentSize.height
        ) {
          texture.resize(contentSize.width, contentSize.height);
        }
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

  private ensureExpressionRenderTextureCount(
    count: number,
    contentSize: { width: number; height: number },
  ) {
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

    this.expressionRenderTextures.forEach((texture) => {
      if (
        texture.width !== contentSize.width ||
        texture.height !== contentSize.height
      ) {
        texture.resize(contentSize.width, contentSize.height);
      }
    });
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
    this.blurFilter.strength = amount * MASK_EDGE_BLUR_SCALE;
    return this.blurFilter;
  }

  private getAlternateEffectTarget(sourceTexture: Texture): RenderTexture | null {
    if (
      sourceTexture === this.effectMaskRenderTexture &&
      this.maskRenderTexture
    ) {
      return this.maskRenderTexture;
    }

    if (
      sourceTexture === this.maskRenderTexture &&
      this.effectMaskRenderTexture
    ) {
      return this.effectMaskRenderTexture;
    }

    return this.effectMaskRenderTexture ?? this.maskRenderTexture ?? null;
  }

  private renderMaskSubsetToTexture(
    maskIds: Set<string>,
    target: RenderTexture,
    transform: Matrix,
  ) {
    if (!this.renderer) return;

    const previousMaskContainerVisibility = this.maskContainer.visible;
    const previousVectorVisibility: Array<{ root: Container; visible: boolean }> = [];
    const previousAssetMaskVisibility: Array<{
      root: Container;
      visible: boolean;
    }> = [];

    this.vectorMaskNodes.forEach((node, maskId) => {
      previousVectorVisibility.push({
        root: node.root,
        visible: node.root.visible,
      });
      node.root.visible = maskIds.has(maskId);
    });

    this.assetMaskNodes.forEach((node, maskId) => {
      const sprite = node.player.sprite;
      previousAssetMaskVisibility.push({
        root: node.root,
        visible: node.root.visible,
      });
      node.root.visible =
        maskIds.has(maskId) && sprite.visible && this.hasUsableTexture(sprite);
    });

    this.maskContainer.visible = true;
    try {
      this.renderer.render({
        container: this.maskContainer,
        target,
        clear: true,
        transform,
      });
    } finally {
      this.maskContainer.visible = previousMaskContainerVisibility;
      previousVectorVisibility.forEach((entry) => {
        entry.root.visible = entry.visible;
      });
      previousAssetMaskVisibility.forEach((entry) => {
        entry.root.visible = entry.visible;
      });
    }
  }

  private isMaskClipRenderable(maskClip: MaskTimelineClip): boolean {
    if (!isAssetBackedMask(maskClip)) {
      return this.vectorMaskNodes.has(maskClip.id);
    }
    const sprite = this.assetMaskNodes.get(maskClip.id)?.player.sprite;
    return !!(sprite && sprite.visible && this.hasUsableTexture(sprite));
  }

  private attachAlphaMaskEffect() {
    if (!this.alphaMaskEffect) return;
    if (typeof this.maskTarget.addEffect !== "function") return;
    const effects = this.maskTarget.effects ?? [];
    if (!effects.includes(this.alphaMaskEffect)) {
      this.maskTarget.addEffect(this.alphaMaskEffect);
    }
  }

  private detachAlphaMaskEffect() {
    if (!this.alphaMaskEffect) return;
    if (typeof this.maskTarget.removeEffect !== "function") return;
    const effects = this.maskTarget.effects ?? [];
    if (effects.includes(this.alphaMaskEffect)) {
      this.maskTarget.removeEffect(this.alphaMaskEffect);
    }
  }

  private removeMaskFromTarget() {
    this.currentMaskMode = "none";
    this.currentInverse = false;
    if (this.perMaskSprite) {
      this.perMaskSprite.blendMode = "normal";
      this.perMaskSprite.filters = null;
    }
    this.detachAlphaMaskEffect();
    this.setMaskOnTarget(null, false);
    this.syncOutputModeVisibility();
  }

  private setMaskOnTarget(mask: Container | null, inverse: boolean) {
    if (typeof this.maskTarget.setMask === "function") {
      this.maskTarget.setMask({ mask, inverse });
      return;
    }
    this.maskTarget.mask = mask;
  }

  private hasUsableTexture(sprite: Sprite): boolean {
    const texture = sprite.texture;
    return !!(
      texture &&
      texture !== Texture.EMPTY &&
      !texture.destroyed &&
      texture.source &&
      !(texture.source as { destroyed?: boolean }).destroyed
    );
  }

  private sanitizeAssetMaskSpriteVisibility() {
    this.assetMaskNodes.forEach((node) => {
      const sprite = node.player.sprite;
      if (sprite.visible && !this.hasUsableTexture(sprite)) {
        sprite.visible = false;
      }
    });
  }

  private hasRenderableContentTexture(): boolean {
    const texture = this.sprite.texture;
    return !!(
      texture &&
      !texture.destroyed &&
      texture.source &&
      !(texture.source as { destroyed?: boolean }).destroyed
    );
  }

  private syncOutputModeVisibility() {
    if (this.renderer) {
      this.maskContainer.visible = this.currentMaskMode === "regular";
    }

    if (!this.maskSprite) {
      return;
    }

    const hasMaskTexture = this.hasUsableTexture(this.maskSprite);
    const shouldKeepMaskSpriteActive =
      this.currentMaskMode === "alpha" && hasMaskTexture;

    // Keep the sprite visible for Pixi's direct-sprite AlphaMask path, but
    // never render it as scene content.
    this.maskSprite.visible = shouldKeepMaskSpriteActive;
    this.maskSprite.renderable = false;
  }
}
