import { Container, Graphics, Matrix, Sprite, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";
import type {
  ClipTransform,
  MaskBooleanExpression,
  MaskTimelineClip,
  TimelineClip,
} from "../../../types/TimelineTypes";
import { usesInverseMaskCompositionAlgebra } from "../../../types/Components";
import type { Asset } from "../../../types/Asset";
import {
  applyClipTransforms,
  calculateClipTime,
} from "../../transformations";
import { livePreviewParamStore } from "../../../core/liveParams/livePreviewParamStore";
import { dispatchTransform } from "../../transformations/catalogue/TransformationRegistry";
import type { TransformState } from "../../transformations/catalogue/types";
import { drawMaskBaseShape, isMaskActiveAtSourceTime } from "../model/maskFactory";
import {
  analyzeMaskBooleanExpression,
  collectUnionMaskIds,
  getMaskLocalId,
  resolveRenderableMaskBooleanExpression,
} from "../model/maskBooleanExpression";
import { useMaskViewStore } from "../store/useMaskViewStore";
import {
  calculatePlayerFrameTime,
  snapFrameTimeSeconds,
} from "../../renderer";
import {
  AssetMaskSourceFactory,
  getAssetBackedMaskId,
  isAssetBackedMask,
  isBrushBufferAssetId,
} from "./AssetMaskSourceFactory";
import { getBrushBufferRevision } from "./brushBufferRegistry";
import {
  MaskApplicationController,
  type MaskApplicationMode,
} from "./MaskApplicationController";
import {
  MaskBooleanTextureRenderer,
  type ResolvedMaskCompositeState,
} from "./MaskBooleanTextureRenderer";
import { MaskSceneNodeRegistry } from "./MaskSceneNodeRegistry";
import type { AssetMaskNode, VectorMaskNode } from "./MaskSceneNodes";
import {
  createMaskApplicationSignature,
  createMaskShapeSignature,
} from "./maskRenderSignatures";
import { resolveMaskRenderableLayout } from "./resolveMaskRenderableLayout";

type TextureWithIdentity = Texture & {
  uid?: number;
  source?: {
    uid?: number;
    destroyed?: boolean;
  };
};

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
 * AlphaMask's direct-sprite path (`renderMaskToTexture = false`).
 *
 * When no renderer is available (unit tests), falls back to the old
 * Container-based AlphaMask approach.
 */
export class SpriteClipMaskController {
  private readonly sprite: Sprite;
  private readonly maskContainer: Container;
  private readonly maskRootContainer: Container | null;
  private readonly maskTarget: Container;
  private readonly renderer: Renderer | null;
  private maskSprite: Sprite | null = null;
  private readonly onAssetMaskFrameReady?: () => void;

  private readonly assetMaskSourceFactory: AssetMaskSourceFactory;
  private readonly nodeRegistry: MaskSceneNodeRegistry;
  private readonly maskApplicationController: MaskApplicationController;
  private readonly maskBooleanTextureRenderer: MaskBooleanTextureRenderer | null;

  constructor(
    sprite: Sprite,
    renderer?: Renderer | null,
    maskRootContainer?: Container | null,
    onAssetMaskFrameReady?: () => void,
  ) {
    this.sprite = sprite;
    this.renderer = renderer ?? null;
    this.maskRootContainer = maskRootContainer ?? null;
    this.onAssetMaskFrameReady = onAssetMaskFrameReady;
    this.maskTarget = sprite as unknown as Container;
    this.maskContainer = new Container();
    this.maskContainer.visible = false;

    if (this.renderer) {
      this.maskSprite = new Sprite();
      this.maskSprite.anchor.set(0.5);
      this.maskSprite.visible = false;
      this.maskSprite.renderable = false;
    }

    this.assetMaskSourceFactory = new AssetMaskSourceFactory(
      this.onAssetMaskFrameReady,
    );
    this.nodeRegistry = new MaskSceneNodeRegistry(
      this.maskContainer,
      this.assetMaskSourceFactory,
      (candidate) => this.hasUsableTexture(candidate),
    );
    this.maskApplicationController = new MaskApplicationController(
      this.maskTarget,
      this.maskContainer,
      this.maskSprite,
      (candidate) => this.hasUsableTexture(candidate),
    );
    this.maskBooleanTextureRenderer =
      this.renderer && this.maskSprite
        ? new MaskBooleanTextureRenderer(
            this.renderer,
            this.nodeRegistry,
            this.maskSprite,
            (candidate) => this.hasUsableTexture(candidate),
          )
        : null;

    this.ensureMaskSceneNodesAttached();
    this.maskApplicationController.syncOutputModeVisibility();
  }

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
  ): Promise<void> {
    this.ensureMaskSceneNodesAttached();
    this.syncMaskSpriteTransform();
    // The composited-alpha path renders `maskContainer` into a content-sized
    // texture with its own centering transform, so the container itself must
    // stay at identity there. The regular path (below) uses `maskContainer`
    // directly as a Pixi mask and re-applies the content sprite's transform.
    this.resetMaskContainerTransform();

    const {
      fps,
      waitForSam2 = false,
      skipSam2FrameRender = false,
    } = options;
    // Transient single-mask preview: while a mask on this clip is being
    // previewed, the equation is temporarily off and NO masking is applied to
    // the content, so the full content shows below. The previewed mask's bounds
    // are drawn separately as an overlay by the interaction layer.
    const previewTarget = useMaskViewStore.getState().maskPreviewTarget;
    const isPreviewingThisClip =
      parentClip.type !== "mask" &&
      !!previewTarget &&
      previewTarget.clipId === parentClip.id &&
      maskClips.some((clip) => getMaskLocalId(clip) === previewTarget.maskId);

    const resolvedMaskExpression =
      parentClip.type === "mask" || isPreviewingThisClip
        ? null
        : resolveRenderableMaskBooleanExpression(parentClip, maskClips);
    const resolvedMaskExpressionAnalysis = analyzeMaskBooleanExpression(
      resolvedMaskExpression,
    );
    const referencedMaskIds = new Set(resolvedMaskExpressionAnalysis.maskIds);
    const referencedMaskClips = maskClips.filter((clip) => {
      const maskId = getMaskLocalId(clip);
      return !!maskId && referencedMaskIds.has(maskId);
    });
    const maskClipByLocalId = new Map<string, MaskTimelineClip>();
    referencedMaskClips.forEach((clip) => {
      const maskId = getMaskLocalId(clip);
      if (maskId) {
        maskClipByLocalId.set(maskId, clip);
      }
    });

    const parentSourceTimeTicks =
      parentClip.type === "mask"
        ? rawTimeTicks
        : calculateClipTime(parentClip, rawTimeTicks, true);
    const activeMaskClips = referencedMaskClips.filter((clip) => {
      // Membership in the resolved expression decides what composites; per-mask
      // apply/preview is no longer a render gate.
      if (!isMaskActiveAtSourceTime(clip.activeRange, parentSourceTimeTicks)) {
        return false;
      }
      const assetMaskId = getAssetBackedMaskId(clip);
      return (
        assetMaskId === null ||
        isBrushBufferAssetId(assetMaskId) ||
        assetsById.has(assetMaskId)
      );
    });
    const activeVectorMasks = activeMaskClips.filter(
      (clip) =>
        !isAssetBackedMask(clip) &&
        clip.maskType !== "sam2" &&
        clip.maskType !== "generation" &&
        clip.maskType !== "brush",
    );
    const activeAssetMasks = activeMaskClips.filter((clip) =>
      isAssetBackedMask(clip),
    );
    const clipContentSize = this.getActiveClipContentSize(logicalDimensions);

    this.nodeRegistry.reconcileVectorNodes(activeVectorMasks.map((clip) => clip.id));
    this.nodeRegistry.reconcileAssetMaskNodes(
      activeAssetMasks
        .map((clip) =>
          this.assetMaskSourceFactory.resolveMaskEntry(clip, assetsById),
        )
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
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
      const node = this.nodeRegistry.getVectorNode(maskClip.id);
      if (!node) {
        return;
      }
      node.root.visible = true;

      const resolvedLayout = resolveMaskRenderableLayout(maskClip, {
        rawTimeTicks,
        parentClipContentSize: clipContentSize,
      });
      const shapeSignature = createMaskShapeSignature(maskClip);
      if (node.shapeSignature !== shapeSignature) {
        node.graphics.clear();
        drawMaskBaseShape(node.graphics, maskClip);
        node.shapeSignature = shapeSignature;
      }

      if (this.shouldRasterizeVectorMask(maskClip)) {
        this.setVectorMaskPresentation(node, "sprite");
        this.syncVectorMaskSprite(node, resolvedLayout.contentSize);
        applyClipTransforms(
          node.sprite,
          maskClip,
          logicalDimensions,
          rawTimeTicks,
          resolvedLayout.contentSize,
          { baseLayoutMode: "origin", notifyLiveParams: false },
        );
      } else {
        this.setVectorMaskPresentation(node, "graphics");
        applyClipTransforms(
          node.graphics,
          maskClip,
          logicalDimensions,
          rawTimeTicks,
          resolvedLayout.contentSize,
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

    for (const maskClip of activeAssetMasks) {
      const node = this.nodeRegistry.getAssetNode(maskClip.id);
      if (!node) {
        continue;
      }
      node.root.visible = true;
      await this.assetMaskSourceFactory.syncMaskNode(node, maskClip, {
        requestedTimeSeconds: requestedMaskTimeSeconds,
        waitForAssetFrame: waitForSam2,
        skipFrameRender: skipSam2FrameRender,
        parentClipContentSize: clipContentSize,
        assetsById,
        hasUsableTexture: (candidate) => this.hasUsableTexture(candidate),
      });

      const resolvedLayout = resolveMaskRenderableLayout(maskClip, {
        rawTimeTicks,
        parentClipContentSize: clipContentSize,
        assetTextureSize: getMaskVideoSpriteContentSize(
          node.player.sprite,
          clipContentSize,
        ),
      });
      applyClipTransforms(
        node.player.sprite,
        maskClip,
        logicalDimensions,
        rawTimeTicks,
        resolvedLayout.contentSize,
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
    const hasCompositeInvert =
      sharedMaskCompositeState.compositeInvert &&
      resolvedMaskExpressionAnalysis.operationCount > 0;
    const hasInvertedMask = activeMaskClips.some(
      (maskClip) => maskClip.maskInverted,
    );
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
    const maskApplicationSignature = createMaskApplicationSignature(
      resolvedMaskExpression,
      activeMaskClips,
      sharedMaskCompositeState,
    );
    this.nodeRegistry.sanitizeAssetMaskSpriteVisibility();

    if (
      this.maskSprite &&
      this.maskBooleanTextureRenderer &&
      shouldUseCompositedAlphaMask
    ) {
      const hasReadyAssetMask = activeAssetMasks.some((maskClip) => {
        const sprite = this.nodeRegistry.getAssetNode(maskClip.id)?.player.sprite;
        return !!(sprite && sprite.visible && this.hasUsableTexture(sprite));
      });

      if (
        (activeVectorMasks.length > 0 || hasReadyAssetMask) &&
        this.hasRenderableContentTexture()
      ) {
        const renderedTexture = this.maskBooleanTextureRenderer.renderExpressionToTexture(
          {
            expression: resolvedMaskExpression,
            expressionAnalysis: resolvedMaskExpressionAnalysis,
            maskClipByLocalId,
            contentSize: clipContentSize,
            compositeState: sharedMaskCompositeState,
            cacheKey: this.createCompositeTextureCacheKey({
              maskApplicationSignature,
              activeMaskClips,
              clipContentSize,
              logicalDimensions,
              parentClip,
              rawTimeTicks,
              requestedMaskTimeSeconds,
              compositeState: sharedMaskCompositeState,
            }),
          },
        );

        if (renderedTexture) {
          this.maskApplicationController.applyAlphaMask(
            this.maskSprite,
            false,
            maskApplicationSignature,
          );
        } else {
          this.maskBooleanTextureRenderer.invalidateCache();
          this.maskApplicationController.clear();
        }
      } else {
        this.maskBooleanTextureRenderer.invalidateCache();
        this.maskApplicationController.clear();
      }
      return;
    }

    this.maskBooleanTextureRenderer?.invalidateCache();

    if (simpleUnionMasks) {
      this.maskApplicationController.applyMaskEffect(
        this.maskContainer,
        false,
        false,
        maskApplicationSignature,
      );
      return;
    }

    if (
      activeAssetMasks.length > 0 ||
      hasInvertedMask ||
      hasSharedEdgeOps ||
      hasCompositeInvert
    ) {
      this.maskApplicationController.applyMaskEffect(
        this.maskContainer,
        singleMask ? (singleMask.maskInverted ?? false) : false,
        true,
        maskApplicationSignature,
      );
      return;
    }

    this.maskApplicationController.applyMaskEffect(
      this.maskContainer,
      singleMask ? (singleMask.maskInverted ?? false) : false,
      false,
      maskApplicationSignature,
    );
  }

  public clear(): void {
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
    this.maskApplicationController.clear();
    this.maskBooleanTextureRenderer?.invalidateCache();
    if (this.maskSprite) {
      this.maskSprite.visible = false;
    }
  }

  public dispose(): void {
    this.clear();
    this.maskApplicationController.dispose();
    this.maskBooleanTextureRenderer?.dispose();
    this.nodeRegistry.dispose();

    if (this.maskSprite) {
      if (this.maskSprite.parent) {
        this.maskSprite.removeFromParent();
      }
      if (!this.maskSprite.destroyed) {
        this.maskSprite.destroy();
      }
      this.maskSprite = null;
    }

    if (this.maskContainer.parent) {
      this.maskContainer.removeFromParent();
    }
    if (!this.maskContainer.destroyed) {
      this.maskContainer.destroy({ children: true });
    }
  }

  public syncMaskSpriteTransform(): void {
    if (!this.maskSprite) {
      return;
    }
    const copyPoint = (
      target:
        | { x: number; y: number; copyFrom?: (src: { x: number; y: number }) => void }
        | undefined,
      src: { x: number; y: number } | undefined,
    ) => {
      if (!target || !src) {
        return;
      }
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

    // The regular (non-composited) path applies `maskContainer` directly as the
    // target's mask, so it must carry the same screen transform as the content
    // sprite. This runs here — after content transforms have been applied by
    // the render paths — rather than mid-`syncMaskClips`, where `this.sprite`'s
    // transform is still stale (the synchronized path applies it afterwards).
    this.syncMaskContainerTransform();
  }

  /**
   * Match `maskContainer` to the content sprite's screen transform. Its child
   * mask nodes are laid out in centre-relative content space (the sprite uses
   * `anchor 0.5`, so a node at local origin maps to the sprite's position), so
   * copying position/scale/rotation/pivot places the regular-path mask exactly
   * over the content. Mirrors `syncMaskSpriteTransform` for the composited path.
   */
  private syncMaskContainerTransform(): void {
    if (!this.maskRootContainer) {
      // No group container: `maskContainer` is parented under the content
      // sprite, so its centre-relative child space already aligns with the
      // content. Leave it at identity.
      this.resetMaskContainerTransform();
      return;
    }
    const position = this.sprite.position as { x: number; y: number } | undefined;
    const scale = this.sprite.scale as { x: number; y: number } | undefined;
    const pivot = this.sprite.pivot as { x: number; y: number } | undefined;
    this.setContainerTransform(
      { x: position?.x ?? 0, y: position?.y ?? 0 },
      { x: scale?.x ?? 1, y: scale?.y ?? 1 },
      this.sprite.rotation ?? 0,
      { x: pivot?.x ?? 0, y: pivot?.y ?? 0 },
    );
  }

  /**
   * Reset `maskContainer` to identity. Required before the composited-alpha
   * path renders it into a content-sized texture with its own centre transform.
   */
  private resetMaskContainerTransform(): void {
    this.setContainerTransform({ x: 0, y: 0 }, { x: 1, y: 1 }, 0, { x: 0, y: 0 });
  }

  private setContainerTransform(
    position: { x: number; y: number },
    scale: { x: number; y: number },
    rotation: number,
    pivot: { x: number; y: number },
  ): void {
    const setPoint = (
      target:
        | {
            x: number;
            y: number;
            set?: (x: number, y?: number) => void;
          }
        | undefined,
      x: number,
      y: number,
    ) => {
      if (!target) {
        return;
      }
      if (typeof target.set === "function") {
        target.set(x, y);
      } else {
        target.x = x;
        target.y = y;
      }
    };

    setPoint(this.maskContainer.position, position.x, position.y);
    setPoint(this.maskContainer.scale, scale.x, scale.y);
    setPoint(this.maskContainer.pivot, pivot.x, pivot.y);
    this.maskContainer.rotation = rotation;
  }

  private get vectorMaskNodes(): Map<string, VectorMaskNode> {
    return this.nodeRegistry.vectorMaskNodes;
  }

  private get assetMaskNodes(): Map<string, AssetMaskNode> {
    return this.nodeRegistry.assetMaskNodes;
  }

  public get currentMaskMode(): MaskApplicationMode {
    return this.maskApplicationController.getCurrentMaskMode();
  }

  public get maskBooleanBlendFilters() {
    return this.maskBooleanTextureRenderer?.getMaskBooleanBlendFilters() ?? {};
  }

  private resolveMaskHostContainer(): Container | null {
    const host = this.maskRootContainer ?? this.maskTarget;
    return host && typeof host.addChild === "function" ? host : null;
  }

  private ensureMaskSceneNodesAttached(): void {
    const host = this.resolveMaskHostContainer();
    if (!host) {
      return;
    }

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
    if (composition?.type !== "mask_composition") {
      return {
        compositeInvert: false,
        growAmount: 0,
        growInvert: false,
        feather: null,
      };
    }

    const transforms = composition.parameters.compositeTransformations;
    const compositeInvert = usesInverseMaskCompositionAlgebra(
      composition.parameters,
    );

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
      if (!transform.isEnabled) {
        return;
      }
      dispatchTransform(state, this.applyLivePreviewOverrides(transform), {
        container: logicalDimensions,
        content: contentSize,
        time: transformTime,
      });
    });

    return {
      compositeInvert,
      growAmount: state.maskGrow?.amount ?? 0,
      growInvert: state.maskGrow?.invert ?? false,
      feather: state.feather ?? null,
    };
  }

  private applyLivePreviewOverrides(
    transform: TimelineClip["transformations"][number],
  ) {
    let nextParameters: Record<string, unknown> | null = null;

    for (const paramName of Object.keys(transform.parameters)) {
      const previewValue = livePreviewParamStore.get(transform.id, paramName);
      if (previewValue === undefined) {
        continue;
      }

      nextParameters ??= { ...transform.parameters };
      nextParameters[paramName] = previewValue;
    }

    return nextParameters
      ? {
          ...transform,
          parameters: nextParameters,
        }
      : transform;
  }

  private createCompositeTextureCacheKey(options: {
    maskApplicationSignature: string;
    activeMaskClips: MaskTimelineClip[];
    clipContentSize: { width: number; height: number };
    logicalDimensions: { width: number; height: number };
    parentClip: TimelineClip;
    rawTimeTicks: number;
    requestedMaskTimeSeconds: number;
    compositeState: ResolvedMaskCompositeState;
  }): string {
    return JSON.stringify({
      maskApplicationSignature: options.maskApplicationSignature,
      rawTimeTicks: options.rawTimeTicks,
      requestedMaskTimeSeconds: options.requestedMaskTimeSeconds,
      contentSize: options.clipContentSize,
      logicalDimensions: options.logicalDimensions,
      compositeState: options.compositeState,
      compositeLivePreview: this.createCompositeLivePreviewSignature(
        options.parentClip,
      ),
      masks: options.activeMaskClips.map((maskClip) => ({
        id: maskClip.id,
        type: maskClip.maskType,
        mode: maskClip.maskMode,
        inverted: maskClip.maskInverted,
        activeRange: maskClip.activeRange,
        parameters: maskClip.maskParameters,
        transformations: maskClip.transformations,
        livePreview: this.createTransformLivePreviewSignature(
          maskClip.transformations,
        ),
        assetId: getAssetBackedMaskId(maskClip),
        texture: this.getAssetMaskTextureSignature(maskClip.id),
      })),
    });
  }

  private getAssetMaskTextureSignature(maskClipId: string): {
    textureUid: number | null;
    sourceUid: number | null;
    width: number;
    height: number;
    visible: boolean;
    brushRevision: number | null;
  } | null {
    const sprite = this.assetMaskNodes.get(maskClipId)?.player.sprite;
    if (!sprite) {
      return null;
    }

    const texture = sprite.texture as TextureWithIdentity;
    return {
      textureUid: texture.uid ?? null,
      sourceUid: texture.source?.uid ?? null,
      width: texture.width,
      height: texture.height,
      visible: sprite.visible,
      brushRevision: getBrushBufferRevision(maskClipId),
    };
  }

  private createCompositeLivePreviewSignature(
    parentClip: TimelineClip,
  ): ReturnType<SpriteClipMaskController["createTransformLivePreviewSignature"]> {
    if (parentClip.type === "mask") {
      return [];
    }

    const composition = (parentClip.components ?? []).find(
      (component) => component.type === "mask_composition",
    );
    if (composition?.type !== "mask_composition") {
      return [];
    }

    return this.createTransformLivePreviewSignature(
      composition.parameters.compositeTransformations,
    );
  }

  private createTransformLivePreviewSignature(
    transformations: readonly ClipTransform[] | undefined,
  ): Array<{
    id: string;
    type: string;
    values: Record<string, number>;
  }> {
    if (!transformations || transformations.length === 0) {
      return [];
    }

    const signature: Array<{
      id: string;
      type: string;
      values: Record<string, number>;
    }> = [];

    transformations.forEach((transform) => {
      const values: Record<string, number> = {};
      Object.keys(transform.parameters)
        .sort()
        .forEach((paramName) => {
          const previewValue = livePreviewParamStore.get(
            transform.id,
            paramName,
          );
          if (previewValue !== undefined) {
            values[paramName] = previewValue;
          }
        });

      if (Object.keys(values).length > 0) {
        signature.push({
          id: transform.id,
          type: transform.type,
          values,
        });
      }
    });

    return signature;
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
      if (
        !maskClip ||
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

  private shouldRasterizeVectorMask(maskClip: MaskTimelineClip): boolean {
    void maskClip;
    return false;
  }

  private setVectorMaskPresentation(
    node: VectorMaskNode,
    presentation: VectorMaskNode["presentation"],
  ): void {
    if (node.presentation === presentation) {
      return;
    }

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
  ): void {
    if (!this.renderer) {
      return;
    }

    const textureChanged = this.nodeRegistry.ensureVectorMaskRenderTexture(
      node,
      contentSize,
    );
    if (!node.rasterTexture) {
      return;
    }

    if (textureChanged || node.rasterSignature !== node.shapeSignature) {
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

  private isMaskClipRenderable(maskClip: MaskTimelineClip): boolean {
    if (!isAssetBackedMask(maskClip)) {
      return this.vectorMaskNodes.has(maskClip.id);
    }

    const sprite = this.assetMaskNodes.get(maskClip.id)?.player.sprite;
    return !!(sprite && sprite.visible && this.hasUsableTexture(sprite));
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

  private hasRenderableContentTexture(): boolean {
    const texture = this.sprite.texture;
    return !!(
      texture &&
      !texture.destroyed &&
      texture.source &&
      !(texture.source as { destroyed?: boolean }).destroyed
    );
  }
}
