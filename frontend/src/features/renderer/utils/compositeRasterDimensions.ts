import type { Asset } from "../../../types/Asset";
import type { CompositeContent } from "../../../types/TimelineTypes";
import { getAssetInput } from "../../userAssets";
import type { FrameDimensions } from "../services/framePlanning/framePlanningTypes";

export const MIN_COMPOSITE_RASTER_SHORT_EDGE = 720;

function positiveDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function resolvePreviewDimensionsAtScale(
  logicalWidth: number,
  logicalHeight: number,
  scale: number,
): FrameDimensions {
  const targetWidth = Math.max(1, Math.floor(logicalWidth * scale));
  if (targetWidth <= 2) {
    return {
      width: targetWidth,
      height: Math.max(
        1,
        Math.round(logicalHeight * (targetWidth / logicalWidth)),
      ),
    };
  }

  // Pixi RenderTexture has one resolution scalar for both axes. Walk down by
  // encoder-compatible width pairs until that scalar also yields an even
  // physical height, so the requested and allocated backing sizes agree.
  for (
    let physicalWidth = targetWidth - (targetWidth % 2);
    physicalWidth >= 2;
    physicalWidth -= 2
  ) {
    const physicalHeight = Math.max(
      1,
      Math.round(logicalHeight * (physicalWidth / logicalWidth)),
    );
    if (physicalHeight <= 2 || physicalHeight % 2 === 0) {
      return { width: physicalWidth, height: physicalHeight };
    }
  }

  return { width: 1, height: 1 };
}

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
 * Fit the logical composite canvas to the physical preview surface without
 * rasterising letterbox/pillarbox space. Live rendering should satisfy the
 * actual preview sink rather than imposing the bake-quality floor or treating
 * project dimensions as a physical raster limit. Callers should supply the
 * renderer's presentation size rather than the project dimensions.
 */
export function resolveCompositePreviewRasterDimensions(
  logicalDimensions: FrameDimensions,
  previewSurfaceDimensions: FrameDimensions,
): FrameDimensions {
  const logicalWidth = positiveDimension(logicalDimensions.width);
  const logicalHeight = positiveDimension(logicalDimensions.height);
  const availableWidth = positiveDimension(previewSurfaceDimensions.width);
  const availableHeight = positiveDimension(previewSurfaceDimensions.height);
  const fittedScale = Math.min(
    availableWidth / logicalWidth,
    availableHeight / logicalHeight,
  );

  return resolvePreviewDimensionsAtScale(
    logicalWidth,
    logicalHeight,
    fittedScale,
  );
}

/**
 * Resolve the largest useful physical raster from file-backed child clips.
 * Unlike bake sizing, this is a ceiling: low-resolution sources remain low
 * resolution and generated-only composites have no source-imposed limit.
 */
export function resolveCompositeSourceRasterCeiling(
  logicalDimensions: FrameDimensions,
  sourceDimensions: readonly FrameDimensions[],
): FrameDimensions | null {
  const logicalWidth = positiveDimension(logicalDimensions.width);
  const logicalHeight = positiveDimension(logicalDimensions.height);
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
  }, 0);
  if (rasterScale <= 0) return null;

  return {
    width: Math.max(1, Math.round(logicalWidth * rasterScale)),
    height: Math.max(1, Math.round(logicalHeight * rasterScale)),
  };
}

export function capCompositePreviewRasterDimensions(
  previewDimensions: FrameDimensions,
  sourceRasterCeiling: FrameDimensions | null,
): FrameDimensions {
  if (!sourceRasterCeiling) return previewDimensions;
  const previewWidth = positiveDimension(previewDimensions.width);
  const previewHeight = positiveDimension(previewDimensions.height);
  const previewPixels = previewWidth * previewHeight;
  const ceilingPixels =
    positiveDimension(sourceRasterCeiling.width) *
    positiveDimension(sourceRasterCeiling.height);
  // Media dimensions cannot bound resolution-independent children such as
  // text, shapes, extensions, or procedural effects.
  const minimumCeiling = resolvePreviewDimensionsAtScale(
    previewWidth,
    previewHeight,
    MIN_COMPOSITE_RASTER_SHORT_EDGE / Math.min(previewWidth, previewHeight),
  );
  const minimumPixels = minimumCeiling.width * minimumCeiling.height;
  const effectiveCeiling =
    ceilingPixels >= minimumPixels ? sourceRasterCeiling : minimumCeiling;

  return previewPixels <= Math.max(ceilingPixels, minimumPixels)
    ? previewDimensions
    : effectiveCeiling;
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
  const sourceCeiling = resolveCompositeSourceRasterCeiling(
    logicalDimensions,
    sourceDimensions,
  );
  const sourceScale = sourceCeiling
    ? Math.sqrt(
        (sourceCeiling.width * sourceCeiling.height) /
          (logicalWidth * logicalHeight),
      )
    : 0;
  const rasterScale = Math.max(minimumScale, sourceScale);

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
  const dimensions = await resolveCompositeSourceDimensions(content, assets);
  return resolveCompositeRasterDimensions(logicalDimensions, dimensions);
}

export async function resolveCompositeSourceRasterCeilingForContent(
  content: CompositeContent,
  assets: readonly Asset[],
  logicalDimensions: FrameDimensions,
): Promise<FrameDimensions | null> {
  const dimensions = await resolveCompositeSourceDimensions(content, assets);
  return resolveCompositeSourceRasterCeiling(logicalDimensions, dimensions);
}

async function resolveCompositeSourceDimensions(
  content: CompositeContent,
  assets: readonly Asset[],
): Promise<FrameDimensions[]> {
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
  return dimensions.filter(
    (candidate): candidate is FrameDimensions => candidate !== null,
  );
}
