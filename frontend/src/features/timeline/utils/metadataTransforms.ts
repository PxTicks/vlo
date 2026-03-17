import type { Asset, MaskCropMetadata } from "../../../types/Asset";
import type { ClipTransform } from "../../../types/TimelineTypes";

interface Size {
  width: number;
  height: number;
}

export interface DeriveClipTransformsOptions {
  fallbackContainerSize?: Size;
}

type MetadataTransformDeriver = (
  asset: Asset,
  options: DeriveClipTransformsOptions,
) => ClipTransform[];

const GEOMETRY_EPSILON = 1e-6;

const METADATA_TRANSFORM_DERIVERS: MetadataTransformDeriver[] = [
  deriveGeneratedMaskCropTransforms,
];

function roundGeometryValue(value: number): number {
  if (Math.abs(value) <= GEOMETRY_EPSILON) {
    return 0;
  }

  return Number(value.toFixed(6));
}

function toSizeTuple(
  value: [number, number] | undefined,
): Size | null {
  if (!value) return null;

  const [width, height] = value;
  if (width <= 0 || height <= 0) return null;

  return { width, height };
}

function resolveCropGeometry(
  metadata: MaskCropMetadata,
  fallbackContainerSize?: Size,
): {
  containerSize: Size;
  cropSize: Size;
  cropPosition: { x: number; y: number };
} | null {
  if (metadata.mode !== "cropped") return null;

  const containerSize =
    toSizeTuple(metadata.container_size) ?? fallbackContainerSize ?? null;
  if (!containerSize) return null;

  const cropSize =
    toSizeTuple(metadata.crop_size) ?? {
      width: containerSize.width * metadata.scale,
      height: containerSize.height * metadata.scale,
    };

  if (cropSize.width <= 0 || cropSize.height <= 0) return null;

  return {
    containerSize,
    cropSize,
    cropPosition: {
      x: metadata.crop_position[0],
      y: metadata.crop_position[1],
    },
  };
}

function deriveGeneratedMaskCropTransforms(
  asset: Asset,
  options: DeriveClipTransformsOptions,
): ClipTransform[] {
  if (asset.type === "audio") return [];

  const metadata = asset.creationMetadata;
  if (!metadata || metadata.source !== "generated" || !metadata.maskCropMetadata) {
    return [];
  }

  const cropGeometry = resolveCropGeometry(
    metadata.maskCropMetadata,
    options.fallbackContainerSize,
  );
  if (!cropGeometry) return [];

  const { containerSize, cropSize, cropPosition } = cropGeometry;
  const cropCenterX = cropPosition.x + cropSize.width / 2;
  const cropCenterY = cropPosition.y + cropSize.height / 2;
  const deltaX = cropCenterX - containerSize.width / 2;
  const deltaY = cropCenterY - containerSize.height / 2;
  const scaleX = cropSize.width / containerSize.width;
  const scaleY = cropSize.height / containerSize.height;

  const transforms: ClipTransform[] = [];

  if (
    Math.abs(deltaX) > GEOMETRY_EPSILON ||
    Math.abs(deltaY) > GEOMETRY_EPSILON
  ) {
    transforms.push({
      id: crypto.randomUUID(),
      type: "position",
      isEnabled: true,
      parameters: {
        x: roundGeometryValue(deltaX),
        y: roundGeometryValue(deltaY),
      },
    });
  }

  if (
    Math.abs(scaleX - 1) > GEOMETRY_EPSILON ||
    Math.abs(scaleY - 1) > GEOMETRY_EPSILON
  ) {
    transforms.push({
      id: crypto.randomUUID(),
      type: "scale",
      isEnabled: true,
      parameters: {
        x: roundGeometryValue(scaleX),
        y: roundGeometryValue(scaleY),
        isLinked: Math.abs(scaleX - scaleY) <= GEOMETRY_EPSILON,
      },
    });
  }

  return transforms;
}

export function deriveClipTransformsFromAsset(
  asset: Asset,
  options: DeriveClipTransformsOptions = {},
): ClipTransform[] {
  return METADATA_TRANSFORM_DERIVERS.flatMap((deriver) =>
    deriver(asset, options),
  );
}
