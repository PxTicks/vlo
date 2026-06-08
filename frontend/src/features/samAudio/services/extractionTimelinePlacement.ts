import type { Asset } from "../../../types/Asset";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { useTimelineStore } from "../../timeline";
import { createClipFromAsset } from "../../timeline/utils/clipFactory";

export function muteSourceClipAudio(clipId: string): void {
  const timeline = useTimelineStore.getState();
  const clip = timeline.clips.find((candidate) => candidate.id === clipId);
  if (!clip || clip.type === "mask" || clip.isMuted === true) {
    return;
  }

  timeline.toggleClipMute(clipId);
}

export function insertExtractedAudioClipBelowSource(
  sourceClip: TimelineClip,
  extractedAudioAsset: Asset,
): string | null {
  const [clipId] = useTimelineStore.getState().addClipsOnNewTracksBelow(
    sourceClip.trackId,
    [
      {
        trackLabel: `${sourceClip.name} Audio`,
        trackType: "audio",
        createClip: (trackId) => {
          const baseClip = createClipFromAsset(extractedAudioAsset);
          if (baseClip.type !== "audio") {
            throw new Error("Extracted audio asset did not create an audio clip.");
          }
          return {
            ...baseClip,
            trackId,
            start: sourceClip.start,
          } as TimelineClip;
        },
      },
    ],
  );

  return clipId ?? null;
}
