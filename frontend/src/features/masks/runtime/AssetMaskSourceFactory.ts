import { Sprite, type Renderer } from "pixi.js";
import type { Asset } from "../../../types/Asset";
import type {
  BrushPaintedBounds,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import { createMaskBinaryThresholdFilter } from "../../transformations/catalogue/mask/maskBinaryThresholdFilter";
import type { SourceFrameSyncRef } from "../../renderer/utils/sourceFrameSync";
import {
  getBrushBufferForRenderer,
  hasBrushContent,
  isBrushBufferExplicitlyEmpty,
} from "./brushBufferRegistry";
import { BrushBufferMaskSource } from "./BrushBufferMaskSource";
import { ImageMaskSource } from "./ImageMaskSource";
import { MaskVideoFramePlayer } from "./MaskVideoFramePlayer";
import type { AssetMaskNodeEntry, AssetMaskFrameSource } from "./MaskSceneNodes";

/**
 * Sentinel asset id used for brush masks whose strokes live only in the GPU
 * buffer (not yet persisted to a PNG). The mask compositor still treats them
 * as asset-backed so they flow through the sprite + threshold-filter path
 * uniformly with SAM2 / generation / committed-brush masks.
 */
export const BRUSH_BUFFER_ASSET_ID_PREFIX = "__brush_buffer__:";

export function isBrushBufferAssetId(id: string): boolean {
  return id.startsWith(BRUSH_BUFFER_ASSET_ID_PREFIX);
}

export function getAssetBackedMaskId(maskClip: MaskTimelineClip): string | null {
  if (maskClip.maskType === "sam2") {
    return maskClip.sam2MaskAssetId ?? null;
  }
  if (maskClip.maskType === "generation") {
    return maskClip.generationMaskAssetId ?? null;
  }
  if (maskClip.maskType === "brush") {
    return maskClip.brushMaskAssetId ?? null;
  }
  return null;
}

export function getSam2MaskGrowAmount(maskClip: MaskTimelineClip): number {
  if (maskClip.maskType !== "sam2") {
    return 0;
  }

  // Negative amounts shrink the mask.
  const amount = maskClip.sam2GrowAmount ?? 0;
  return Number.isFinite(amount) ? amount : 0;
}

function getImageMaskHydrationContext(
  maskClip: MaskTimelineClip,
  parentClipContentSize: { width: number; height: number },
): {
  canvasWidth: number;
  canvasHeight: number;
  paintedBounds: BrushPaintedBounds | null;
} {
  if (maskClip.maskType === "brush") {
    const params = maskClip.maskParameters;
    return {
      canvasWidth: Math.max(1, params?.baseWidth ?? 1),
      canvasHeight: Math.max(1, params?.baseHeight ?? 1),
      paintedBounds: maskClip.brushPaintedBounds ?? null,
    };
  }

  const canvasWidth = Math.max(1, Math.round(parentClipContentSize.width));
  const canvasHeight = Math.max(1, Math.round(parentClipContentSize.height));
  return {
    canvasWidth,
    canvasHeight,
    paintedBounds: {
      x: 0,
      y: 0,
      width: canvasWidth,
      height: canvasHeight,
    },
  };
}

export class AssetMaskSourceFactory {
  private readonly renderer: Renderer | null;
  private readonly onAssetMaskFrameReady?: () => void;

  constructor(
    renderer: Renderer | null,
    onAssetMaskFrameReady?: () => void,
  ) {
    this.renderer = renderer;
    this.onAssetMaskFrameReady = onAssetMaskFrameReady;
  }

  public resolveMaskEntry(
    maskClip: MaskTimelineClip,
    assetsById?: Map<string, Asset>,
  ): AssetMaskNodeEntry | null {
    if (maskClip.maskType === "brush") {
      const liveBuffer = this.renderer
        ? getBrushBufferForRenderer(maskClip.id, this.renderer)
        : null;
      // Stay on the live-buffer source for as long as a buffer with content
      // exists on this renderer. `kind` decides node identity in
      // `reconcileAssetMaskNodes`, so flipping to the PNG-backed image source
      // tears the buffer source down — letting a transient gap in the buffer's
      // cached bounds flip it would drop uncommitted strokes and re-read a
      // stale crop from disk.
      if (hasBrushContent(liveBuffer, maskClip.brushPaintedBounds)) {
        return {
          maskId: maskClip.id,
          assetId:
            maskClip.brushMaskAssetId ??
            `${BRUSH_BUFFER_ASSET_ID_PREFIX}${maskClip.id}`,
          kind: "brush",
        };
      }

      // A cleared buffer supersedes the PNG it was committed from. Falling
      // through to the image source here would flash the mask the user just
      // cleared back onto the clip until the async flush drops the asset id.
      if (
        isBrushBufferExplicitlyEmpty(liveBuffer) ||
        !maskClip.brushMaskAssetId
      ) {
        return null;
      }

      return {
        maskId: maskClip.id,
        assetId: maskClip.brushMaskAssetId,
        kind: "image",
      };
    }

    const assetId = getAssetBackedMaskId(maskClip);
    if (!assetId) {
      return null;
    }

    const isBrushBuffer = isBrushBufferAssetId(assetId);
    const assetType = isBrushBuffer ? "image" : assetsById?.get(assetId)?.type;

    return {
      maskId: maskClip.id,
      assetId,
      kind: assetType === "image" ? "image" : "video",
    };
  }

  public createMaskSource(entry: AssetMaskNodeEntry): {
    player: AssetMaskFrameSource;
    thresholdFilter: ReturnType<typeof createMaskBinaryThresholdFilter>;
  } {
    let player: AssetMaskFrameSource;
    if (entry.kind === "brush") {
      if (!this.renderer) {
        throw new Error("Brush mask source requires an owning renderer");
      }
      player = new BrushBufferMaskSource(
        entry.maskId,
        this.renderer,
        this.onAssetMaskFrameReady,
      );
    } else if (entry.kind === "image") {
      player = new ImageMaskSource(this.onAssetMaskFrameReady);
    } else {
      player = new MaskVideoFramePlayer(
        entry.maskId,
        this.onAssetMaskFrameReady,
      );
    }
    const thresholdFilter = createMaskBinaryThresholdFilter();
    player.sprite.filters = [thresholdFilter];

    return {
      player,
      thresholdFilter,
    };
  }

  public async syncMaskNode(
    node: {
      player: AssetMaskFrameSource;
      assetId: string;
    },
    maskClip: MaskTimelineClip,
    options: {
      waitForAssetFrame: boolean;
      skipFrameRender: boolean;
      sourceFrame: SourceFrameSyncRef;
      parentClipContentSize: { width: number; height: number };
      assetsById: Map<string, Asset>;
      hasUsableTexture: (sprite: Sprite) => boolean;
    },
  ): Promise<void> {
    const maskAssetId =
      node.player instanceof BrushBufferMaskSource
        ? // A brush node keeps its live-buffer source across the first PNG
          // commit, so read the clip's asset id rather than the placeholder the
          // node was built with — reading `node.assetId` here only ever
          // re-writes its own stale value.
          (maskClip.brushMaskAssetId ?? node.assetId)
        : getAssetBackedMaskId(maskClip);
    if (!maskAssetId) {
      return;
    }

    const isBrushBuffer = isBrushBufferAssetId(maskAssetId);
    const asset = isBrushBuffer ? null : options.assetsById.get(maskAssetId);

    if (node.player instanceof BrushBufferMaskSource) {
      node.player.setHydrationContext(
        getImageMaskHydrationContext(
          maskClip,
          options.parentClipContentSize,
        ),
      );
      // Rebind every sync. Brush pixels change outside the render loop (the
      // registry notifies subscribers), and nothing else re-runs the bind on
      // this path — so without this a buffer that was momentarily absent stays
      // hidden until an unrelated timeline commit happens to re-hydrate it.
      node.player.syncToBuffer();
    } else if (node.player instanceof ImageMaskSource) {
      const context = getImageMaskHydrationContext(
        maskClip,
        options.parentClipContentSize,
      );
      node.player.setGeometryContext({
        canvasWidth: context.canvasWidth,
        canvasHeight: context.canvasHeight,
        imageBounds:
          context.paintedBounds ?? {
            x: 0,
            y: 0,
            width: context.canvasWidth,
            height: context.canvasHeight,
          },
      });
    }

    if (asset) {
      node.assetId = asset.id;
      try {
        await node.player.setSource(asset);
      } catch (error) {
        // A strict (export) frame must not quietly drop a mask: the clip would
        // render unmasked. Only interactive playback tolerates a missing image.
        if (!(node.player instanceof ImageMaskSource) || options.waitForAssetFrame) {
          throw error;
        }
        node.player.sprite.visible = false;
        console.warn("Image mask source failed to load", error);
        return;
      }
    } else {
      node.assetId = maskAssetId;
    }

    if (!isBrushBuffer) {
      if (!options.skipFrameRender) {
        if (options.waitForAssetFrame) {
          await node.player.renderAt(options.sourceFrame, {
            strict: true,
          });
        } else {
          void node.player
            .renderAt(options.sourceFrame)
            .catch((error) => {
              console.warn("Mask video frame update failed", error);
            });
        }
      } else if (!node.player.hasFrame()) {
        void node.player.renderAt(options.sourceFrame).catch((error) => {
          console.warn("Mask video frame update failed", error);
        });
      }
    }

    if (
      node.player.sprite.visible &&
      !options.hasUsableTexture(node.player.sprite)
    ) {
      node.player.sprite.visible = false;
    }
  }

  public disposeMaskNode(node: {
    player: AssetMaskFrameSource;
    thresholdFilter: ReturnType<typeof createMaskBinaryThresholdFilter>;
  }): void {
    node.thresholdFilter.destroy();
    node.player.dispose();
  }
}
