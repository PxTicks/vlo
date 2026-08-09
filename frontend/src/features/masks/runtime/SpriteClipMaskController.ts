import { Container, Graphics, Matrix, Sprite, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";
import type {
  ClipTransform,
  MaskBooleanExpression,
  MaskTimelineClip,
  TimelineClip,
} from "../../../types/TimelineTypes";
import { isAssetBackedClip } from "../../../types/TimelineTypes";
import { usesInverseMaskCompositionAlgebra } from "../../../types/Components";
import type { Asset } from "../../../types/Asset";
import { markPixiPreviewOnly } from "../../../core/pixi/previewOnly";
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
  createSourceFrameSyncRefFromSourceTicks,
  type SourceFrameSyncRef,
} from "../../renderer/utils/sourceFrameSync";
import {
  AssetMaskSourceFactory,
  getAssetBackedMaskId,
} from "./AssetMaskSourceFactory";
import { getBrushBufferForRenderer } from "./brushBufferRegistry";
import {
  MaskApplicationController,
  type MaskApplicationMode,
} from "./MaskApplicationController";
import {
  MaskBooleanTextureRenderer,
  type ResolvedMaskCompositeState,
} from "./MaskBooleanTextureRenderer";
import { MaskTextureResolver } from "./MaskTextureResolver";
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

interface CompositedSpatialMaskContext {
  expression: MaskBooleanExpression;
  expressionAnalysis: ReturnType<typeof analyzeMaskBooleanExpression>;
  maskClipByLocalId: Map<string, MaskTimelineClip>;
  activeMaskClips: MaskTimelineClip[];
  clipContentSize: { width: number; height: number };
  logicalDimensions: { width: number; height: number };
  parentClip: TimelineClip;
  rawTimeTicks: number;
  requestedMaskTimeSeconds: number;
  compositeState: ResolvedMaskCompositeState;
  maskApplicationSignature: string;
}

export interface LiveMaskTransformSyncResult {
  didUpdate: boolean;
  needsSpatialPresentationRefresh: boolean;
  needsEffectPresentationRefresh: boolean;
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
 * Manages mask application for a frame Sprite.
 *
 * By default the Sprite itself is masked. Callers that render companion
 * sprites can provide a separate mask target (normally the final presentation
 * Container) so one spatial mask clips the complete rendered subtree.
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
  private readonly previewContainer: Container;
  private readonly previewSprite: Sprite;
  private readonly onAssetMaskFrameReady?: () => void;

  private readonly assetMaskSourceFactory: AssetMaskSourceFactory;
  private readonly nodeRegistry: MaskSceneNodeRegistry;
  private readonly maskApplicationController: MaskApplicationController;
  private readonly previewMaskApplicationController: MaskApplicationController;
  private readonly maskBooleanTextureRenderer: MaskBooleanTextureRenderer | null;
  // Effect-level masking resolves an independent expression to a coverage
  // texture. It shares the synced mask nodes (one registry) but uses its own
  // resolver/pool so it never contends with the spatial mask's presentation.
  private readonly effectMaskCoverageResolver: MaskTextureResolver | null;
  private compositedSpatialMaskContext: CompositedSpatialMaskContext | null =
    null;
  private lastNodeSyncMaskClipByLocalId: Map<string, MaskTimelineClip> =
    new Map();
  private lastNodeSyncContentSize: { width: number; height: number } | null =
    null;
  private activeClipContentSizeOverride: {
    width: number;
    height: number;
  } | null = null;
  // Monotonic counter bumped whenever the mask scene this controller resolves
  // coverage from changes (every `syncMaskClips`, and `clear`). Effect-mask
  // output caching keys on this so a coverage change (new mask, edited mask,
  // arriving SAM2/asset frame, vector geometry at a new time) invalidates a
  // cached effect render even though the filter params and source frame are
  // unchanged. Conservative by design: any sync bumps it, so a cache hit is
  // only possible when nothing was re-synced (the stable/paused case).
  private maskSyncEpoch = 0;

  constructor(
    sprite: Sprite,
    renderer?: Renderer | null,
    maskRootContainer?: Container | null,
    onAssetMaskFrameReady?: () => void,
    maskTarget?: Container | null,
  ) {
    this.sprite = sprite;
    this.renderer = renderer ?? null;
    this.maskRootContainer = maskRootContainer ?? null;
    this.onAssetMaskFrameReady = onAssetMaskFrameReady;
    this.maskTarget = maskTarget ?? (sprite as unknown as Container);
    this.maskContainer = new Container();
    this.maskContainer.visible = false;

    if (this.renderer) {
      this.maskSprite = new Sprite();
      this.maskSprite.anchor.set(0.5);
      this.maskSprite.visible = false;
      this.maskSprite.renderable = false;
    }
    this.previewContainer = new Container();
    markPixiPreviewOnly(this.previewContainer);
    this.previewContainer.visible = false;
    this.previewContainer.renderable = false;
    this.previewSprite = new Sprite(Texture.WHITE);
    this.previewSprite.anchor.set(0.5);
    this.previewSprite.tint = 0x60a5fa;
    this.previewSprite.alpha = 0.45;
    this.previewContainer.addChild(this.previewSprite);

    this.assetMaskSourceFactory = new AssetMaskSourceFactory(
      this.renderer,
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
    // The preview controller must NOT share the real mask-scene container:
    // `MaskApplicationController.syncOutputModeVisibility` writes
    // `maskContainer.visible = (mode === "regular")`, and the preview
    // controller's mode is never "regular". Sharing it meant every
    // `hideMaskNodePreviewOverlay()` (run on the non-preview path each frame)
    // clobbered the applied regular mask's container to invisible, while the
    // main controller's apply dedup skipped re-asserting it — silently
    // disabling normal-mode masks. Give the preview controller a throwaway
    // container it can toggle harmlessly; the real container's visibility is
    // owned solely by the main controller.
    this.previewMaskApplicationController = new MaskApplicationController(
      this.previewContainer,
      new Container(),
      null,
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
    this.effectMaskCoverageResolver = this.renderer
      ? new MaskTextureResolver(
          this.renderer,
          this.nodeRegistry,
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
      sourceFrame?: SourceFrameSyncRef;
      waitForSam2?: boolean;
      skipSam2FrameRender?: boolean;
    } = {},
  ): Promise<void> {
    // Bump first: any sync may change the coverage the effect-mask path reads,
    // so the epoch must advance even on the early-return branches below.
    this.maskSyncEpoch += 1;
    this.ensureMaskSceneNodesAttached();
    this.syncMaskSpriteTransform();
    // The composited-alpha path renders `maskContainer` into a content-sized
    // texture with its own centering transform, so the container itself must
    // stay at identity there. The regular path (below) uses `maskContainer`
    // directly as a Pixi mask and re-applies the content sprite's transform.
    this.resetMaskContainerTransform();

    const {
      fps,
      sourceFrame,
      waitForSam2 = false,
      skipSam2FrameRender = false,
    } = options;
    // Transient single-mask preview: while a mask on this clip is being
    // previewed, the equation is temporarily off and NO masking is applied to
    // the content, so the full content shows below. Asset-backed previews still
    // sync their mask node here, then render mask coverage through the normal
    // mask texture path before applying it to a blue overlay sprite.
    const previewTarget = useMaskViewStore.getState().maskPreviewTarget;
    const previewMaskClip =
      parentClip.type !== "mask" &&
      previewTarget?.clipId === parentClip.id
        ? (maskClips.find(
            (clip) => getMaskLocalId(clip) === previewTarget.maskId,
          ) ?? null)
        : null;
    const isPreviewingThisClip = !!previewMaskClip;
    const usesMaskNodePreview =
      !!previewMaskClip &&
      this.assetMaskSourceFactory.resolveMaskEntry(
        previewMaskClip,
        assetsById,
      ) !== null;

    const resolvedMaskExpression =
      parentClip.type === "mask" || isPreviewingThisClip
        ? null
        : resolveRenderableMaskBooleanExpression(parentClip, maskClips);
    const resolvedMaskExpressionAnalysis = analyzeMaskBooleanExpression(
      resolvedMaskExpression,
    );
    const referencedMaskIds = isPreviewingThisClip
      ? new Set([previewTarget?.maskId ?? ""])
      : new Set(resolvedMaskExpressionAnalysis.maskIds);

    // Effect-level masks reference the clip's masks through an independent
    // expression, so their masks need synced nodes too — but they must NOT join
    // the spatial mask's application set (that would composite them into the
    // clip's own mask). So we sync nodes for (spatial ∪ effect) masks while the
    // spatial application below stays on `referencedMaskIds`. Empty for mask
    // clips / preview, so the node-sync set then equals the spatial set exactly.
    const effectMaskIds =
      isPreviewingThisClip || parentClip.type === "mask"
        ? new Set<string>()
        : this.collectEffectMaskIds(parentClip);
    const nodeSyncMaskIds =
      effectMaskIds.size === 0
        ? referencedMaskIds
        : new Set<string>([...referencedMaskIds, ...effectMaskIds]);

    const nodeSyncMaskClips =
      isPreviewingThisClip && previewMaskClip
        ? [previewMaskClip]
        : maskClips.filter((clip) => {
            const maskId = getMaskLocalId(clip);
            return !!maskId && nodeSyncMaskIds.has(maskId);
          });
    // The lookup spans the node-sync set so effect-mask coverage can resolve its
    // masks; extra entries are unused by the spatial application below.
    const maskClipByLocalId = new Map<string, MaskTimelineClip>();
    nodeSyncMaskClips.forEach((clip) => {
      const maskId = getMaskLocalId(clip);
      if (maskId) {
        maskClipByLocalId.set(maskId, clip);
      }
    });
    const assetEntryByMaskClipId = new Map(
      nodeSyncMaskClips.flatMap((clip) => {
        const entry = this.assetMaskSourceFactory.resolveMaskEntry(
          clip,
          assetsById,
        );
        return entry ? [[clip.id, entry] as const] : [];
      }),
    );

    const parentSourceTimeTicks =
      parentClip.type === "mask"
        ? rawTimeTicks
        : calculateClipTime(parentClip, rawTimeTicks, true);
    // Membership in the resolved expression decides what composites; per-mask
    // apply/preview is no longer a render gate.
    const isActiveForRender = (clip: MaskTimelineClip): boolean => {
      if (!isMaskActiveAtSourceTime(clip.activeRange, parentSourceTimeTicks)) {
        return false;
      }
      const entry = assetEntryByMaskClipId.get(clip.id);
      return (
        entry === undefined ||
        entry.kind === "brush" ||
        assetsById.has(entry.assetId)
      );
    };
    const isPlainVectorMask = (clip: MaskTimelineClip): boolean =>
      !assetEntryByMaskClipId.has(clip.id) &&
      clip.maskType !== "sam2" &&
      clip.maskType !== "generation" &&
      clip.maskType !== "brush";

    // Spatial application set (what the clip's own mask composites).
    const referencedMaskClips = isPreviewingThisClip && previewMaskClip
      ? [previewMaskClip]
      : maskClips.filter((clip) => {
          const maskId = getMaskLocalId(clip);
          return !!maskId && referencedMaskIds.has(maskId);
        });
    const activeMaskClips = referencedMaskClips.filter(isActiveForRender);
    const activeVectorMasks = activeMaskClips.filter(isPlainVectorMask);
    const activeAssetMasks = activeMaskClips.filter((clip) =>
      assetEntryByMaskClipId.has(clip.id),
    );

    // Node-sync set (superset of the spatial set; nodes only). Equals the
    // spatial sets when no effect masks, keeping reconcile/sync byte-identical.
    const activeNodeSyncMaskClips = nodeSyncMaskClips.filter(isActiveForRender);
    const nodeSyncVectorMasks =
      activeNodeSyncMaskClips.filter(isPlainVectorMask);
    const nodeSyncAssetMasks = activeNodeSyncMaskClips.filter((clip) =>
      assetEntryByMaskClipId.has(clip.id),
    );

    const clipContentSize = this.getActiveClipContentSize(logicalDimensions);
    this.lastNodeSyncMaskClipByLocalId = maskClipByLocalId;
    this.lastNodeSyncContentSize = clipContentSize;

    this.nodeRegistry.reconcileVectorNodes(
      nodeSyncVectorMasks.map((clip) => clip.id),
    );
    this.nodeRegistry.reconcileAssetMaskNodes(
      nodeSyncAssetMasks
        .map((clip) => assetEntryByMaskClipId.get(clip.id) ?? null)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    );

    nodeSyncVectorMasks.forEach((maskClip) => {
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

    const resolvedSourceFrame =
      sourceFrame ??
      createSourceFrameSyncRefFromSourceTicks({
        clip: parentClip,
        assetId: isAssetBackedClip(parentClip) ? parentClip.assetId : null,
        effectiveTrackTick: parentClip.start + rawTimeTicks,
        rawClipTick: rawTimeTicks,
        sourceTimeTicks: parentSourceTimeTicks,
        fps: fps ?? 30,
        generation: 0,
      });
    const requestedMaskTimeSeconds = resolvedSourceFrame.snappedTimeSeconds;

    for (const maskClip of nodeSyncAssetMasks) {
      const node = this.nodeRegistry.getAssetNode(maskClip.id);
      if (!node) {
        continue;
      }
      node.root.visible = true;
      await this.assetMaskSourceFactory.syncMaskNode(node, maskClip, {
        waitForAssetFrame: waitForSam2,
        skipFrameRender: skipSam2FrameRender,
        parentClipContentSize: clipContentSize,
        assetsById,
        hasUsableTexture: (candidate) => this.hasUsableTexture(candidate),
        sourceFrame: resolvedSourceFrame,
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

    // The registry also contains effect-only masks so their coverage can be
    // rendered later. Keep those nodes out of the persistent scene: the direct
    // spatial-mask fast path attaches this whole container as a Pixi stencil,
    // and any visible effect-only node would otherwise be unioned into the
    // clip's own mask. MaskTextureResolver temporarily selects the nodes needed
    // for each effect expression and restores this spatial-only baseline.
    this.syncSpatialMaskNodeVisibility(
      new Set(activeMaskClips.map((maskClip) => maskClip.id)),
    );

    this.compositedSpatialMaskContext = null;
    if (isPreviewingThisClip) {
      this.nodeRegistry.sanitizeAssetMaskSpriteVisibility();
      if (usesMaskNodePreview) {
        const hasReadyPreviewMask = activeMaskClips.some((maskClip) =>
          this.isMaskClipRenderable(maskClip),
        );
        const previewMaskId = previewTarget?.maskId ?? null;
        const previewMaskSprite =
          hasReadyPreviewMask && previewMaskId
            ? this.renderMaskNodePreviewMaskSprite({
                previewMaskId,
                maskClipByLocalId,
                activeMaskClips,
                clipContentSize,
                logicalDimensions,
                parentClip,
                rawTimeTicks,
                requestedMaskTimeSeconds,
              })
            : null;
        if (previewMaskSprite) {
          this.showMaskNodePreviewOverlay(clipContentSize, previewMaskSprite);
        } else {
          // Keep the synced node alive while its asset frame is pending. A
          // preview-mode miss must not tear down the applied-mask scene and
          // leave the following mode transition with nothing to restore.
          this.clearSpatialPresentation();
        }
      } else {
        // Vector previews are drawn by the interaction overlay. Preserve their
        // runtime node so returning to apply mode only changes presentation.
        this.clearSpatialPresentation();
      }
      return;
    }

    this.hideMaskNodePreviewOverlay();

    if (!resolvedMaskExpression || referencedMaskIds.size === 0) {
      this.clearForNoSpatialMask(effectMaskIds.size > 0);
      return;
    }

    if (activeMaskClips.length === 0) {
      this.clearForNoSpatialMask(effectMaskIds.size > 0);
      return;
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
        this.compositedSpatialMaskContext = {
          expression: resolvedMaskExpression,
          expressionAnalysis: resolvedMaskExpressionAnalysis,
          maskClipByLocalId,
          activeMaskClips,
          clipContentSize,
          logicalDimensions,
          parentClip,
          rawTimeTicks,
          requestedMaskTimeSeconds,
          compositeState: sharedMaskCompositeState,
          maskApplicationSignature,
        };
        this.renderCompositedSpatialMask();
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

  public setActiveClipContentSizeOverride(
    contentSize: { width: number; height: number } | null,
  ): void {
    this.activeClipContentSizeOverride = contentSize
      ? { ...contentSize }
      : null;
  }

  /**
   * Apply transient layout overrides directly to the existing mask scene.
   *
   * Both the blue preview overlay and the applied content mask resolve from
   * these same nodes. Moving them synchronously keeps either presentation
   * attached to the pointer; composited coverage is refreshed separately at
   * Pixi's pre-render boundary.
   */
  public syncLiveMaskTransforms(
    maskClips: readonly MaskTimelineClip[],
    parentClip: TimelineClip,
    logicalDimensions: { width: number; height: number },
    rawTimeTicks: number,
    maskClipIds?: ReadonlySet<string>,
  ): LiveMaskTransformSyncResult {
    const clipContentSize = this.getActiveClipContentSize(logicalDimensions);
    const effectMaskIds = this.collectEffectMaskIds(parentClip);
    let didUpdate = false;
    let needsEffectPresentationRefresh = false;

    for (const maskClip of maskClips) {
      if (maskClipIds && !maskClipIds.has(maskClip.id)) {
        continue;
      }
      const vectorNode = this.nodeRegistry.getVectorNode(maskClip.id);
      if (vectorNode) {
        const resolvedLayout = resolveMaskRenderableLayout(maskClip, {
          rawTimeTicks,
          parentClipContentSize: clipContentSize,
        });
        if (vectorNode.presentation === "sprite") {
          this.syncVectorMaskSprite(vectorNode, resolvedLayout.contentSize);
          applyClipTransforms(
            vectorNode.sprite,
            maskClip,
            logicalDimensions,
            rawTimeTicks,
            resolvedLayout.contentSize,
            { baseLayoutMode: "origin", notifyLiveParams: false },
          );
        } else {
          applyClipTransforms(
            vectorNode.graphics,
            maskClip,
            logicalDimensions,
            rawTimeTicks,
            resolvedLayout.contentSize,
            { baseLayoutMode: "origin", notifyLiveParams: false },
          );
        }
        didUpdate = true;
        const localId = getMaskLocalId(maskClip);
        needsEffectPresentationRefresh ||=
          localId !== null && effectMaskIds.has(localId);
        continue;
      }

      const assetNode = this.nodeRegistry.getAssetNode(maskClip.id);
      if (!assetNode) {
        continue;
      }
      const resolvedLayout = resolveMaskRenderableLayout(maskClip, {
        rawTimeTicks,
        parentClipContentSize: clipContentSize,
        assetTextureSize: getMaskVideoSpriteContentSize(
          assetNode.player.sprite,
          clipContentSize,
        ),
      });
      applyClipTransforms(
        assetNode.player.sprite,
        maskClip,
        logicalDimensions,
        rawTimeTicks,
        resolvedLayout.contentSize,
        { baseLayoutMode: "origin", notifyLiveParams: false },
      );
      didUpdate = true;
      const localId = getMaskLocalId(maskClip);
      needsEffectPresentationRefresh ||=
        localId !== null && effectMaskIds.has(localId);
    }

    // Parent movement is independent of mask-local movement, but both previews
    // and applied masks share this attachment transform.
    this.syncMaskSpriteTransform();
    if (this.compositedSpatialMaskContext) {
      // Coverage textures render maskContainer in content-local coordinates.
      // syncMaskSpriteTransform aligns direct masks to the content sprite, so
      // restore identity before the compositor consumes the same nodes.
      this.resetMaskContainerTransform();
      this.refreshCompositedContextModel(
        maskClips,
        parentClip,
        logicalDimensions,
        rawTimeTicks,
      );
    }

    if (didUpdate) {
      // Effect-mask output keys include this epoch. Live node movement must
      // invalidate that output even though no structural mask sync occurred.
      this.maskSyncEpoch += 1;
    }

    return {
      didUpdate,
      needsSpatialPresentationRefresh:
        didUpdate && this.compositedSpatialMaskContext !== null,
      needsEffectPresentationRefresh:
        didUpdate && needsEffectPresentationRefresh,
    };
  }

  /**
   * Rebuild only the GPU coverage texture for the already-synced mask scene.
   * No nodes, sources, decoder frames, or application mode are reconciled.
   */
  public refreshLiveMaskPresentation(): void {
    // Both the spatial compositor and effect-mask resolver consume nodes in
    // content-local space. Direct presentation alignment is restored by the
    // track transform pass after effect output has been resolved.
    this.resetMaskContainerTransform();
    this.renderCompositedSpatialMask();
  }

  /**
   * Mask ids referenced by any enabled effect mask on the clip's filter
   * transforms. These masks need synced nodes (so their coverage can render)
   * even when they're absent from the clip's own spatial mask expression.
   */
  private collectEffectMaskIds(parentClip: TimelineClip): Set<string> {
    const ids = new Set<string>();
    if (parentClip.type === "mask") {
      return ids;
    }
    for (const transform of parentClip.transformations ?? []) {
      if (transform.type !== "filter" || !transform.isEnabled) {
        continue;
      }
      const effectMask = transform.effectMask;
      if (!effectMask?.enabled || !effectMask.expression) {
        continue;
      }
      for (const maskId of analyzeMaskBooleanExpression(effectMask.expression)
        .maskIds) {
        ids.add(maskId);
      }
    }
    return ids;
  }

  /**
   * Resolve an effect mask's expression to a coverage texture (red channel),
   * using the nodes synced by the most recent {@link syncMaskClips}. Returns
   * `null` when there is nothing renderable this frame (no masks, no synced
   * size, or no renderer) — the caller must then contribute nothing, never
   * apply the effect to the whole clip.
   *
   * v1 effect masks carry no edge ops, so coverage is resolved with a neutral
   * composite state. Uses a dedicated resolver/pool, so it never disturbs the
   * spatial mask's cached presentation.
   */
  public resolveEffectMaskCoverage(
    expression: MaskBooleanExpression,
    contentSize?: { width: number; height: number },
  ): Texture | null {
    if (!this.effectMaskCoverageResolver) {
      return null;
    }
    const expressionAnalysis = analyzeMaskBooleanExpression(expression);
    if (expressionAnalysis.maskIds.length === 0) {
      return null;
    }
    const size = contentSize ?? this.lastNodeSyncContentSize;
    if (!size) {
      return null;
    }
    return this.effectMaskCoverageResolver.resolveCoverageTexture({
      expression,
      expressionAnalysis,
      maskClipByLocalId: this.lastNodeSyncMaskClipByLocalId,
      contentSize: size,
      compositeState: {
        compositeInvert: false,
        growAmount: 0,
        growInvert: false,
        feather: null,
      },
    });
  }

  /**
   * Return whether an effect-mask expression has a currently renderable leaf
   * without allocating textures or issuing GPU passes.
   */
  public canResolveEffectMaskCoverage(
    expression: MaskBooleanExpression,
    contentSize?: { width: number; height: number },
  ): boolean {
    if (!this.effectMaskCoverageResolver) return false;
    const expressionAnalysis = analyzeMaskBooleanExpression(expression);
    if (expressionAnalysis.maskIds.length === 0) return false;
    if (!(contentSize ?? this.lastNodeSyncContentSize)) return false;
    return this.effectMaskCoverageResolver.hasRenderableCoverage({
      expressionAnalysis,
      maskClipByLocalId: this.lastNodeSyncMaskClipByLocalId,
    });
  }

  public clear(): void {
    // Clearing drops the coverage source, so it must invalidate effect-mask
    // caches keyed on the sync epoch (same reasoning as `syncMaskClips`).
    this.maskSyncEpoch += 1;
    this.activeClipContentSizeOverride = null;
    this.clearMaskNodes();
    this.clearSpatialPresentation();
  }

  /**
   * Monotonic token for the current mask-scene state (see {@link maskSyncEpoch}).
   * Effect-mask output caching folds this into its cache key so any mask change
   * invalidates a stable filter+source render.
   */
  public getMaskSyncEpoch(): number {
    return this.maskSyncEpoch;
  }

  /**
   * Hide/clear every mask scene node and drop the effect-coverage context.
   * After this, {@link resolveEffectMaskCoverage} has nothing to render — node
   * renderability only checks node existence, so the stale context must be
   * dropped here too, or coverage could still resolve over blank space / after
   * clip removal.
   */
  private clearMaskNodes(): void {
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
    this.lastNodeSyncMaskClipByLocalId = new Map();
    this.lastNodeSyncContentSize = null;
  }

  private syncSpatialMaskNodeVisibility(
    activeSpatialMaskClipIds: ReadonlySet<string>,
  ): void {
    this.vectorMaskNodes.forEach((node, maskClipId) => {
      node.root.visible = activeSpatialMaskClipIds.has(maskClipId);
    });
    this.assetMaskNodes.forEach((node, maskClipId) => {
      node.root.visible = activeSpatialMaskClipIds.has(maskClipId);
    });
  }

  /**
   * Remove the clip's spatial mask application (alpha mask, presentation
   * texture, cache, preview overlay) WITHOUT touching synced nodes — so an
   * effect-only clip keeps its mask geometry/visibility for coverage.
   */
  private clearSpatialPresentation(): void {
    this.compositedSpatialMaskContext = null;
    this.maskApplicationController.clear();
    this.maskBooleanTextureRenderer?.invalidateCache();
    if (this.maskSprite) {
      this.maskSprite.visible = false;
    }
    this.hideMaskNodePreviewOverlay();
  }

  /**
   * Bail-out cleanup when the clip has no spatial mask to apply: always drop the
   * spatial presentation, but keep synced nodes (and the coverage context) when
   * effect masks still need them.
   */
  private clearForNoSpatialMask(hasEffectMasks: boolean): void {
    this.clearSpatialPresentation();
    if (!hasEffectMasks) {
      this.clearMaskNodes();
    }
  }

  public dispose(): void {
    this.clear();
    this.maskApplicationController.dispose();
    this.previewMaskApplicationController.dispose();
    this.maskBooleanTextureRenderer?.dispose();
    this.effectMaskCoverageResolver?.dispose();
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
    if (this.previewContainer.parent) {
      this.previewContainer.removeFromParent();
    }
    if (!this.previewContainer.destroyed) {
      this.previewContainer.destroy({ children: true, texture: false });
    }

    if (this.maskContainer.parent) {
      this.maskContainer.removeFromParent();
    }
    if (!this.maskContainer.destroyed) {
      this.maskContainer.destroy({ children: true });
    }
  }

  public syncMaskSpriteTransform(): void {
    if (this.maskSprite) {
      this.syncSpriteTransformToContent(this.maskSprite);
      this.maskSprite.alpha = this.sprite.alpha;
    }
    this.syncContainerTransformToContent(this.previewContainer);

    // The regular (non-composited) path applies `maskContainer` directly as the
    // target's mask, so it must carry the same screen transform as the content
    // sprite. This runs here — after content transforms have been applied by
    // the render paths — rather than mid-`syncMaskClips`, where `this.sprite`'s
    // transform is still stale (the synchronized path applies it afterwards).
    this.syncMaskContainerTransform();
  }

  private syncSpriteTransformToContent(targetSprite: Sprite): void {
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
    copyPoint(targetSprite.anchor, this.sprite.anchor);
    copyPoint(targetSprite.pivot, this.sprite.pivot);

    const maskPosition = targetSprite.position as {
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

    const maskScale = targetSprite.scale as {
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

    targetSprite.rotation = this.sprite.rotation;
  }

  private syncContainerTransformToContent(targetContainer: Container): void {
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

    setPoint(
      targetContainer.position,
      this.sprite.position.x,
      this.sprite.position.y,
    );
    setPoint(targetContainer.scale, this.sprite.scale.x, this.sprite.scale.y);
    setPoint(targetContainer.pivot, this.sprite.pivot.x, this.sprite.pivot.y);
    targetContainer.rotation = this.sprite.rotation;
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

  private renderCompositedSpatialMask(): void {
    const context = this.compositedSpatialMaskContext;
    if (
      !context ||
      !this.maskSprite ||
      !this.maskBooleanTextureRenderer
    ) {
      return;
    }

    this.resetMaskContainerTransform();
    const renderedTexture =
      this.maskBooleanTextureRenderer.renderExpressionToTexture({
        expression: context.expression,
        expressionAnalysis: context.expressionAnalysis,
        maskClipByLocalId: context.maskClipByLocalId,
        contentSize: context.clipContentSize,
        compositeState: context.compositeState,
        cacheKey: this.createCompositeTextureCacheKey({
          maskApplicationSignature: context.maskApplicationSignature,
          activeMaskClips: context.activeMaskClips,
          clipContentSize: context.clipContentSize,
          logicalDimensions: context.logicalDimensions,
          parentClip: context.parentClip,
          rawTimeTicks: context.rawTimeTicks,
          requestedMaskTimeSeconds: context.requestedMaskTimeSeconds,
          compositeState: context.compositeState,
        }),
      });

    if (renderedTexture) {
      this.maskApplicationController.applyAlphaMask(
        this.maskSprite,
        false,
        context.maskApplicationSignature,
      );
      return;
    }

    this.maskBooleanTextureRenderer.invalidateCache();
    this.maskApplicationController.clear();
  }

  private refreshCompositedContextModel(
    maskClips: readonly MaskTimelineClip[],
    parentClip: TimelineClip,
    logicalDimensions: { width: number; height: number },
    rawTimeTicks: number,
  ): void {
    const context = this.compositedSpatialMaskContext;
    if (!context) {
      return;
    }

    const maskClipById = new Map(
      maskClips.map((maskClip) => [maskClip.id, maskClip] as const),
    );
    context.activeMaskClips = context.activeMaskClips.map(
      (maskClip) => maskClipById.get(maskClip.id) ?? maskClip,
    );
    context.maskClipByLocalId = new Map(
      [...context.maskClipByLocalId].map(([localId, maskClip]) => [
        localId,
        maskClipById.get(maskClip.id) ?? maskClip,
      ]),
    );
    context.parentClip = parentClip;
    context.logicalDimensions = logicalDimensions;
    context.rawTimeTicks = rawTimeTicks;
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
      brushRevision:
        this.renderer
          ? getBrushBufferForRenderer(maskClipId, this.renderer)?.revision ??
            null
          : null,
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
        this.assetMaskNodes.has(maskClip.id) ||
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

  private renderMaskNodePreviewMaskSprite(options: {
    previewMaskId: string;
    maskClipByLocalId: Map<string, MaskTimelineClip>;
    activeMaskClips: MaskTimelineClip[];
    clipContentSize: { width: number; height: number };
    logicalDimensions: { width: number; height: number };
    parentClip: TimelineClip;
    rawTimeTicks: number;
    requestedMaskTimeSeconds: number;
  }): Sprite | null {
    if (!this.maskSprite || !this.maskBooleanTextureRenderer) {
      return null;
    }

    const expression: MaskBooleanExpression = {
      kind: "mask_ref",
      maskId: options.previewMaskId,
    };
    const expressionAnalysis = analyzeMaskBooleanExpression(expression);
    const compositeState: ResolvedMaskCompositeState = {
      compositeInvert: false,
      growAmount: 0,
      growInvert: false,
      feather: null,
    };
    const maskApplicationSignature = createMaskApplicationSignature(
      expression,
      options.activeMaskClips,
      compositeState,
    );
    const renderedTexture =
      this.maskBooleanTextureRenderer.renderExpressionToTexture({
        expression,
        expressionAnalysis,
        maskClipByLocalId: options.maskClipByLocalId,
        contentSize: options.clipContentSize,
        compositeState,
        cacheKey: this.createCompositeTextureCacheKey({
          maskApplicationSignature: `preview:${maskApplicationSignature}`,
          activeMaskClips: options.activeMaskClips,
          clipContentSize: options.clipContentSize,
          logicalDimensions: options.logicalDimensions,
          parentClip: options.parentClip,
          rawTimeTicks: options.rawTimeTicks,
          requestedMaskTimeSeconds: options.requestedMaskTimeSeconds,
          compositeState,
        }),
      });

    if (!renderedTexture || !this.hasUsableTexture(this.maskSprite)) {
      this.maskBooleanTextureRenderer.invalidateCache();
      return null;
    }

    this.syncSpriteTransformToContent(this.maskSprite);
    this.maskSprite.alpha = this.sprite.alpha;
    this.maskSprite.visible = true;
    this.maskSprite.renderable = false;
    return this.maskSprite;
  }

  private showMaskNodePreviewOverlay(
    contentSize: { width: number; height: number },
    maskSprite: Sprite,
  ): void {
    const host = this.resolveMaskHostContainer();
    if (!host) {
      return;
    }

    this.maskApplicationController.clear();
    // Match the applied AlphaMask path: keep the mask graph available to the
    // effect without drawing the raw mask sprites into the scene.
    this.maskContainer.visible = false;
    maskSprite.visible = true;
    maskSprite.renderable = false;

    const previewContainer = this.previewContainer;
    if (previewContainer.parent !== host) {
      if (previewContainer.parent) {
        previewContainer.removeFromParent();
      }
      host.addChild(previewContainer);
    } else {
      // Keep the visual preview above the content sprite without changing the
      // maskContainer's established position below it.
      host.addChild(previewContainer);
    }

    const previewSprite = this.previewSprite;
    previewSprite.texture = Texture.WHITE;
    const textureWidth = Math.max(1, previewSprite.texture.width);
    const textureHeight = Math.max(1, previewSprite.texture.height);
    previewSprite.scale.set(
      contentSize.width / textureWidth,
      contentSize.height / textureHeight,
    );
    previewSprite.tint = 0x60a5fa;
    previewSprite.alpha = 0.45;
    previewContainer.visible = true;
    previewContainer.renderable = true;
    this.previewMaskApplicationController.applyAlphaMask(
      maskSprite,
      false,
      "sam2-preview",
    );
    this.syncContainerTransformToContent(previewContainer);
    this.syncMaskContainerTransform();
  }

  private hideMaskNodePreviewOverlay(): void {
    this.previewMaskApplicationController.clear();
    this.previewContainer.visible = false;
    this.previewContainer.renderable = false;
  }

  private getActiveClipContentSize(logicalDimensions: {
    width: number;
    height: number;
  }): { width: number; height: number } {
    if (this.activeClipContentSizeOverride) {
      return this.activeClipContentSizeOverride;
    }
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
    const sprite = this.assetMaskNodes.get(maskClip.id)?.player.sprite;
    if (sprite) {
      return sprite.visible && this.hasUsableTexture(sprite);
    }

    return this.vectorMaskNodes.has(maskClip.id);
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
