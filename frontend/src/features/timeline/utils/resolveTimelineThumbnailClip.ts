import type { Asset } from "../../../types/Asset";
import type {
  AssetBackedBaseClip,
  AssetBackedTimelineClip,
  CompositeAsset,
} from "../../../types/TimelineTypes";
import { resolveCompositeBakeSelection } from "../../composite";

export interface ResolveTimelineThumbnailClipOptions {
  clip: AssetBackedBaseClip | AssetBackedTimelineClip;
  composite: CompositeAsset | undefined;
  assets: readonly Asset[];
  logicalDimensions: { width: number; height: number };
  projectFps: number;
}

/** Selects the same valid baked asset as frame planning, without trusting the
 * placement's history-bearing asset pointer. */
export function resolveTimelineThumbnailClip(
  options: ResolveTimelineThumbnailClipOptions,
): AssetBackedBaseClip | AssetBackedTimelineClip {
  const { clip, composite } = options;
  const compositeId = "compositeId" in clip ? clip.compositeId : undefined;
  if (!compositeId || composite?.id !== compositeId) {
    return clip;
  }

  const { validity } = resolveCompositeBakeSelection({
    composite,
    assets: options.assets,
    logicalDimensions: options.logicalDimensions,
    projectFps: options.projectFps,
  });
  if (!validity.valid || validity.assetId === clip.assetId) {
    return clip;
  }

  return { ...clip, assetId: validity.assetId };
}
