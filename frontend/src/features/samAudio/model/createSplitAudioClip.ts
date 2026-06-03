import type { Asset } from "../../../types/Asset";
import type {
  AudioTimelineClip,
  CompositeContent,
  CompositeTimelineClip,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { createCompositeTimelineClip } from "../../composite/utils/createCompositeClip";

function createAudioTrack(id: string, label: string): TimelineTrack {
  return {
    id,
    type: "audio",
    label,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function createStemClip(
  asset: Asset,
  trackId: string,
  name: string,
  durationTicks: number,
): AudioTimelineClip {
  return {
    id: `clip_${crypto.randomUUID()}`,
    type: "audio",
    name,
    assetId: asset.id,
    trackId,
    start: 0,
    sourceDuration: durationTicks,
    timelineDuration: durationTicks,
    croppedSourceDuration: durationTicks,
    offset: 0,
    transformedDuration: durationTicks,
    transformedOffset: 0,
    transformations: [],
  };
}

export interface CreateSplitAudioClipArgs {
  sourceClip: TimelineClip;
  targetAsset: Asset;
  residualAsset: Asset;
  durationTicks: number;
  fps: number;
  trackId: string;
}

export function createSplitAudioClip({
  sourceClip,
  targetAsset,
  residualAsset,
  durationTicks,
  fps,
  trackId,
}: CreateSplitAudioClipArgs): CompositeTimelineClip {
  const safeDuration = Math.max(1, Math.round(durationTicks));
  const targetTrack = createAudioTrack(`track_${crypto.randomUUID()}`, "Target");
  const residualTrack = createAudioTrack(
    `track_${crypto.randomUUID()}`,
    "Residual",
  );
  const content: CompositeContent = {
    tracks: [targetTrack, residualTrack],
    clips: [
      createStemClip(targetAsset, targetTrack.id, "Target", safeDuration),
      createStemClip(residualAsset, residualTrack.id, "Residual", safeDuration),
    ],
    durationTicks: safeDuration,
    fps,
    frameStep: 1,
  };

  const splitClip = createCompositeTimelineClip({
    content,
    contentKind: "audio",
    trackId,
    start: sourceClip.start,
    proxyDurationTicks: safeDuration,
    name: `${sourceClip.name} split audio`,
  });

  return {
    ...splitClip,
    sourceDuration: safeDuration,
    timelineDuration: sourceClip.timelineDuration,
    croppedSourceDuration: safeDuration,
    offset: 0,
    transformedDuration: sourceClip.timelineDuration,
    transformedOffset: 0,
    transformations: structuredClone(sourceClip.transformations ?? []),
  };
}
