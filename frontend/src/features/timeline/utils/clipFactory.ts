import type { Asset } from "../../../types/Asset";
import type { BaseClip, ClipType } from "../../../types/TimelineTypes";
import { getProjectDimensions } from "../../renderer/utils/dimensions";
import { useProjectStore } from "../../project/useProjectStore";
import { TICKS_PER_SECOND } from "../constants";
import {
  deriveClipTransformsFromAsset,
  deriveExtractedAudioClipState,
} from "./metadataTransforms";

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
  const { aspectRatio } = useProjectStore.getState().config;
  const metadataClipState =
    asset.type === "audio"
      ? deriveExtractedAudioClipState(asset, durationTicks)
      : null;
  const transformations =
    metadataClipState?.transformations ??
    deriveClipTransformsFromAsset(asset, {
      fallbackContainerSize: getProjectDimensions(aspectRatio),
    });

  return {
    id: `clip_${crypto.randomUUID()}`,
    type,
    name: asset.name,
    assetId: asset.id,
    sourceDuration: isImage ? null : durationTicks,
    timelineDuration: metadataClipState?.timelineDuration ?? durationTicks,
    croppedSourceDuration:
      metadataClipState?.croppedSourceDuration ?? durationTicks,
    offset: metadataClipState?.offset ?? 0,
    transformations,
    transformedDuration:
      metadataClipState?.transformedDuration ?? durationTicks,
    transformedOffset: metadataClipState?.transformedOffset ?? 0,
  };
};
