import type { MaskTimelineClip } from "../../../types/TimelineTypes";
import type { MaskLayoutState } from "../model/maskFactory";
import {
  getMaskClipLocalId,
  resolveMaskRenderableContentSize,
  type ResolvedMaskRenderableLayout,
} from "../model/maskRenderableLayout";
import { resolveMaskLayoutStateAtTime } from "../model/maskTimelineClip";
import { getBrushBuffer } from "./brushBufferRegistry";

function getMaskBaseSize(maskClip: MaskTimelineClip): {
  width: number;
  height: number;
} {
  const params = maskClip.maskParameters;
  return {
    width: Math.max(1, params?.baseWidth ?? 1),
    height: Math.max(1, params?.baseHeight ?? 1),
  };
}

export function resolveMaskRenderableLayout(
  maskClip: MaskTimelineClip,
  options: {
    parentClipContentSize: { width: number; height: number };
    rawTimeTicks?: number;
    layout?: MaskLayoutState;
    assetTextureSize?: { width: number; height: number } | null;
  },
): ResolvedMaskRenderableLayout {
  const baseSize = getMaskBaseSize(maskClip);
  const layout =
    options.layout ??
    resolveMaskLayoutStateAtTime(maskClip, options.rawTimeTicks ?? 0);
  const paintedBounds =
    maskClip.maskType === "brush"
      ? getBrushBuffer(maskClip.id)?.paintedBounds ??
        maskClip.brushPaintedBounds ??
        null
      : null;

  if (maskClip.maskType === "brush") {
    return {
      maskClipId: maskClip.id,
      localMaskId: getMaskClipLocalId(maskClip.id),
      contentSize: resolveMaskRenderableContentSize(
        baseSize,
        baseSize,
        options.assetTextureSize,
      ),
      layout,
      hitArea:
        paintedBounds && paintedBounds.width > 0 && paintedBounds.height > 0
          ? "painted-bounds"
          : "none",
      paintedBounds,
    };
  }

  if (maskClip.maskType === "generation" || maskClip.maskType === "sam2") {
    return {
      maskClipId: maskClip.id,
      localMaskId: getMaskClipLocalId(maskClip.id),
      contentSize: resolveMaskRenderableContentSize(
        baseSize,
        options.parentClipContentSize,
        options.assetTextureSize,
      ),
      layout,
      hitArea: "asset-rectangle",
      paintedBounds: null,
    };
  }

  return {
    maskClipId: maskClip.id,
    localMaskId: getMaskClipLocalId(maskClip.id),
    contentSize: baseSize,
    layout,
    hitArea: "base-shape",
    paintedBounds: null,
  };
}
