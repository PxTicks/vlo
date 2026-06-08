import type { Asset } from "../../../types/Asset";
import type {
  AudioTimelineClip,
  TimelineClip,
} from "../../../types/TimelineTypes";

export type SamAudioStem = "target" | "residual";

export interface CreateSplitAudioStemClipArgs {
  sourceClip: TimelineClip;
  asset: Asset;
  stem: SamAudioStem;
  durationTicks: number;
  trackId: string;
}

export interface CreateSplitAudioClipsArgs {
  sourceClip: TimelineClip;
  targetAsset: Asset;
  residualAsset: Asset;
  durationTicks: number;
  targetTrackId: string;
  residualTrackId: string;
}

export interface SplitAudioTimelineClips {
  targetClip: AudioTimelineClip;
  residualClip: AudioTimelineClip;
}

export function createSplitAudioStemClip({
  sourceClip,
  asset,
  stem,
  durationTicks,
  trackId,
}: CreateSplitAudioStemClipArgs): AudioTimelineClip {
  const safeDuration = Math.max(1, Math.round(durationTicks));
  const safeTimelineDuration = Math.max(
    1,
    Math.round(sourceClip.timelineDuration || safeDuration),
  );
  const label = stem === "target" ? "Target" : "Residual";

  return {
    id: `clip_${crypto.randomUUID()}`,
    type: "audio",
    name: `${sourceClip.name} ${label}`,
    assetId: asset.id,
    trackId,
    start: sourceClip.start,
    sourceDuration: safeDuration,
    timelineDuration: safeTimelineDuration,
    croppedSourceDuration: safeDuration,
    offset: 0,
    transformedDuration: safeTimelineDuration,
    transformedOffset: 0,
    transformations: structuredClone(sourceClip.transformations ?? []),
  };
}

export function createSplitAudioClips({
  sourceClip,
  targetAsset,
  residualAsset,
  durationTicks,
  targetTrackId,
  residualTrackId,
}: CreateSplitAudioClipsArgs): SplitAudioTimelineClips {
  return {
    targetClip: createSplitAudioStemClip({
      sourceClip,
      asset: targetAsset,
      stem: "target",
      durationTicks,
      trackId: targetTrackId,
    }),
    residualClip: createSplitAudioStemClip({
      sourceClip,
      asset: residualAsset,
      stem: "residual",
      durationTicks,
      trackId: residualTrackId,
    }),
  };
}
