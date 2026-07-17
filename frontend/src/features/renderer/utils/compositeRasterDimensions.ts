import type { Asset } from "../../../types/Asset";
import type { CompositeContent } from "../../../types/TimelineTypes";
import { getAssetInput } from "../../userAssets";
import type { FrameDimensions } from "../services/framePlanning/framePlanningTypes";

export const MIN_COMPOSITE_RASTER_SHORT_EDGE = 720;

function isUsableDimensions(
  dimensions: FrameDimensions,
): dimensions is FrameDimensions {
  return (
    Number.isFinite(dimensions.width) &&
    Number.isFinite(dimensions.height) &&
    dimensions.width > 0 &&
    dimensions.height > 0
  );
}

/**
 * Preserve the composite's logical aspect while matching the largest source's
 * pixel resolution. The 720px short-edge floor keeps generated and text-only
 * scenes useful without forcing low-resolution composites to 1080p.
 */
export function resolveCompositeRasterDimensions(
  logicalDimensions: FrameDimensions,
  sourceDimensions: readonly FrameDimensions[],
): FrameDimensions {
  const logicalWidth = Math.max(1, logicalDimensions.width);
  const logicalHeight = Math.max(1, logicalDimensions.height);
  const minimumScale =
    MIN_COMPOSITE_RASTER_SHORT_EDGE /
    Math.max(1, Math.min(logicalWidth, logicalHeight));
  const rasterScale = sourceDimensions.reduce((largest, dimensions) => {
    if (!isUsableDimensions(dimensions)) {
      return largest;
    }
    return Math.max(
      largest,
      Math.sqrt(
        (dimensions.width * dimensions.height) /
          (logicalWidth * logicalHeight),
      ),
    );
  }, minimumScale);

  return {
    width: Math.max(1, Math.round(logicalWidth * rasterScale)),
    height: Math.max(1, Math.round(logicalHeight * rasterScale)),
  };
}

async function resolveAssetDimensions(
  asset: Asset,
): Promise<FrameDimensions | null> {
  if (asset.type !== "video" && asset.type !== "image") {
    return null;
  }
  try {
    const input = await getAssetInput(asset.id);
    const track = await input?.getPrimaryVideoTrack();
    const width = track?.displayWidth ?? 0;
    const height = track?.displayHeight ?? 0;
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    // Missing or irregular media falls back to the 720p floor and remains
    // renderable through the ordinary diagnostic path.
    return null;
  }
}

export async function resolveCompositeRasterDimensionsForContent(
  content: CompositeContent,
  assets: readonly Asset[],
  logicalDimensions: FrameDimensions,
): Promise<FrameDimensions> {
  const referencedAssetIds = new Set(
    content.clips.flatMap((clip) =>
      "assetId" in clip && typeof clip.assetId === "string"
        ? [clip.assetId]
        : [],
    ),
  );
  const dimensions = await Promise.all(
    assets
      .filter((asset) => referencedAssetIds.has(asset.id))
      .map(resolveAssetDimensions),
  );
  return resolveCompositeRasterDimensions(
    logicalDimensions,
    dimensions.filter(
      (candidate): candidate is FrameDimensions => candidate !== null,
    ),
  );
}
