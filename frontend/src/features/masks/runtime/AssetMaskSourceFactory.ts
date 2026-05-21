import { Sprite } from "pixi.js";
import type { Asset } from "../../../types/Asset";
import type {
  BrushPaintedBounds,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import { createMaskBinaryThresholdFilter } from "../../transformations/catalogue/mask/maskBinaryThresholdFilter";
import { getBrushBuffer } from "./brushBufferRegistry";
import { BrushBufferMaskSource } from "./BrushBufferMaskSource";
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
    if (maskClip.brushMaskAssetId) {
      return maskClip.brushMaskAssetId;
    }
    if (getBrushBuffer(maskClip.id)?.paintedBounds) {
      return `${BRUSH_BUFFER_ASSET_ID_PREFIX}${maskClip.id}`;
    }
    return null;
  }
  return null;
}

export function isAssetBackedMask(maskClip: MaskTimelineClip): boolean {
  return getAssetBackedMaskId(maskClip) !== null;
}

export function getSam2MaskGrowAmount(maskClip: MaskTimelineClip): number {
  if (maskClip.maskType !== "sam2") {
    return 0;
  }

  const amount = maskClip.sam2GrowAmount ?? 0;
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
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
  private readonly onAssetMaskFrameReady?: () => void;

  constructor(onAssetMaskFrameReady?: () => void) {
    this.onAssetMaskFrameReady = onAssetMaskFrameReady;
  }

  public resolveMaskEntry(
    maskClip: MaskTimelineClip,
    assetsById?: Map<string, Asset>,
  ): AssetMaskNodeEntry | null {
    const assetId = getAssetBackedMaskId(maskClip);
    if (!assetId) {
      return null;
    }

    const isBrushBuffer = isBrushBufferAssetId(assetId);
    const assetType = isBrushBuffer ? "image" : assetsById?.get(assetId)?.type;

    return {
      maskId: maskClip.id,
      assetId,
      kind:
        maskClip.maskType === "brush" || assetType === "image"
          ? "image"
          : "video",
    };
  }

  public createMaskSource(entry: AssetMaskNodeEntry): {
    player: AssetMaskFrameSource;
    thresholdFilter: ReturnType<typeof createMaskBinaryThresholdFilter>;
  } {
    const player: AssetMaskFrameSource =
      entry.kind === "image"
        ? new BrushBufferMaskSource(entry.maskId, this.onAssetMaskFrameReady)
        : new MaskVideoFramePlayer(entry.maskId, this.onAssetMaskFrameReady);
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
      requestedTimeSeconds: number;
      waitForAssetFrame: boolean;
      skipFrameRender: boolean;
      parentClipContentSize: { width: number; height: number };
      assetsById: Map<string, Asset>;
      hasUsableTexture: (sprite: Sprite) => boolean;
    },
  ): Promise<void> {
    const maskAssetId = getAssetBackedMaskId(maskClip);
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
    }

    if (asset) {
      node.assetId = asset.id;
      await node.player.setSource(asset);
    } else {
      node.assetId = maskAssetId;
    }

    if (!isBrushBuffer) {
      if (!options.skipFrameRender) {
        if (options.waitForAssetFrame) {
          await node.player.renderAt(options.requestedTimeSeconds, {
            strict: true,
          });
        } else {
          void node.player
            .renderAt(options.requestedTimeSeconds)
            .catch((error) => {
              console.warn("Mask video frame update failed", error);
            });
        }
      } else if (!node.player.hasFrame()) {
        void node.player.renderAt(options.requestedTimeSeconds).catch((error) => {
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
