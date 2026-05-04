import type {
  MaskBooleanExpression,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import type { ResolvedMaskCompositeState } from "./MaskBooleanTextureRenderer";
import { getAssetBackedMaskId, getSam2MaskGrowAmount } from "./AssetMaskSourceFactory";

export function createMaskShapeSignature(maskClip: MaskTimelineClip): string {
  return JSON.stringify({
    type: maskClip.maskType,
    baseWidth: maskClip.maskParameters?.baseWidth,
    baseHeight: maskClip.maskParameters?.baseHeight,
  });
}

export function createMaskApplicationSignature(
  expression: MaskBooleanExpression | null,
  activeMaskClips: MaskTimelineClip[],
  compositeState: ResolvedMaskCompositeState,
): string {
  return JSON.stringify({
    expression,
    masks: activeMaskClips.map((maskClip) => ({
      id: maskClip.id,
      type: maskClip.maskType,
      mode: maskClip.maskMode,
      inverted: maskClip.maskInverted,
      assetId: getAssetBackedMaskId(maskClip),
      sam2GrowAmount: getSam2MaskGrowAmount(maskClip),
    })),
    compositeInvert: compositeState.compositeInvert,
    growInvert: compositeState.growInvert,
    featherMode: compositeState.feather?.mode ?? null,
    featherInvert: compositeState.feather?.invert ?? null,
  });
}
