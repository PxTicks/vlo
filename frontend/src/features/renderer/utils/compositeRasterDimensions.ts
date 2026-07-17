import type { FrameDimensions } from "../services/framePlanning/framePlanningTypes";

export const MIN_COMPOSITE_RASTER_HEIGHT = 720;

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
 * pixel area. The 720-line floor keeps generated/text-only scenes useful
 * without forcing every low-resolution composite through a 1080p target.
 */
export function resolveCompositeRasterDimensions(
  logicalDimensions: FrameDimensions,
  sourceDimensions: readonly FrameDimensions[],
): FrameDimensions {
  const logicalWidth = Math.max(1, logicalDimensions.width);
  const logicalHeight = Math.max(1, logicalDimensions.height);
  const aspectRatio = logicalWidth / logicalHeight;
  const minimumArea =
    aspectRatio * MIN_COMPOSITE_RASTER_HEIGHT * MIN_COMPOSITE_RASTER_HEIGHT;
  const largestSourceArea = sourceDimensions.reduce((largest, dimensions) => {
    if (!isUsableDimensions(dimensions)) {
      return largest;
    }
    return Math.max(largest, dimensions.width * dimensions.height);
  }, 0);
  const rasterHeight = Math.max(
    MIN_COMPOSITE_RASTER_HEIGHT,
    Math.round(Math.sqrt(Math.max(minimumArea, largestSourceArea) / aspectRatio)),
  );

  return {
    width: Math.max(1, Math.round(rasterHeight * aspectRatio)),
    height: rasterHeight,
  };
}
