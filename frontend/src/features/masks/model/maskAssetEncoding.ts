import type { Asset, MaskAssetEncoding } from "../../../types/Asset";

/**
 * The `tsdf8_k8` distance band (docs/mask-distance-field-plan.md): level
 * `127.5 - 8 * d`, d in pixels and negative inside. Mirrors
 * backend/services/sam2/sam2_distance.py.
 */
export const MASK_DISTANCE_LEVELS_PER_PIXEL = 8;
export const MASK_DISTANCE_ZERO_LEVEL = 127.5;
/** Distance the band holds before it saturates, in pixels. */
export const MASK_DISTANCE_BAND_PX =
  MASK_DISTANCE_ZERO_LEVEL / MASK_DISTANCE_LEVELS_PER_PIXEL;

/** Allowance for codec error near the band's saturated edge, in texels. */
const DISTANCE_BAND_MARGIN = 0.5;

export function resolveMaskAssetEncoding(
  asset: Asset | null | undefined,
): MaskAssetEncoding {
  const metadata = asset?.creationMetadata;
  return metadata?.source === "sam2_mask" && metadata.maskEncoding === "tsdf8_k8"
    ? "tsdf8_k8"
    : "binary";
}

/**
 * How far a distance field rendered at `texelsPerAssetPixel` stays exact, in
 * texels. A field is re-encoded in texels at the band's own levels, so it
 * saturates at the band whether the asset was magnified or not; a reduced
 * asset holds proportionally less.
 */
export function resolveDistanceFieldBand(texelsPerAssetPixel: number): number {
  const scale =
    Number.isFinite(texelsPerAssetPixel) && texelsPerAssetPixel > 0
      ? texelsPerAssetPixel
      : 1;
  return MASK_DISTANCE_BAND_PX * Math.min(1, scale) - DISTANCE_BAND_MARGIN;
}
