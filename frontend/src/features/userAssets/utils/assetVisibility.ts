import type { Asset } from "../../../types/Asset";

export function isAssetVisibleInBrowser(asset: Asset): boolean {
  return (
    asset.creationMetadata?.source !== "sam2_mask" &&
    asset.creationMetadata?.source !== "generation_mask" &&
    asset.creationMetadata?.source !== "brush_mask" &&
    asset.creationMetadata?.source !== "composite"
  );
}
