import type { Asset } from "../../../types/Asset";
import type { BaseClip, ClipType } from "../../../types/TimelineTypes";
import { getProjectDimensions } from "../../renderer";
import { useProjectStore } from "../../project/useProjectStore";
import { TICKS_PER_SECOND } from "../constants";
import { deriveClipTransformsFromAsset } from "./metadataTransforms";

export const createClipFromAsset = (asset: Asset): BaseClip => {
  // AssetType is "video" | "image" | "audio", which matches ClipType subset
  const type: ClipType = asset.type;
  const isImage = asset.type === "image";
  const hasFiniteDuration =
    typeof asset.duration === "number" &&
    Number.isFinite(asset.duration) &&
    asset.duration > 0;

  // Still images use a default duration, but timed media should rely on real metadata.
  const durationSeconds = hasFiniteDuration
    ? (asset.duration ?? 0)
    : isImage
      ? 5
      : 0;
  const durationTicks = Math.max(
    0,
    Math.floor(durationSeconds * TICKS_PER_SECOND),
  );
  const aspectRatio = useProjectStore.getState().config.aspectRatio;
  const transformations = deriveClipTransformsFromAsset(asset, {
    fallbackContainerSize: getProjectDimensions(aspectRatio),
  });

  return {
    id: `clip_${crypto.randomUUID()}`,
    type,
    name: asset.name,
    assetId: asset.id,
    sourceDuration: isImage ? null : durationTicks,
    timelineDuration: durationTicks,
    croppedSourceDuration: durationTicks,
    offset: 0,
    transformations,
    transformedDuration: durationTicks, // 1:1 initially
    transformedOffset: 0, // No crop initially
  };
};
