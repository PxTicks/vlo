import type { Asset } from "../../../types/Asset";
import type { TimelineClip } from "../../../types/TimelineTypes";
import {
  addTimelineClipsOnNewTracksBelow,
  createTimelineClipFromAsset,
  getTimelineClipById,
  toggleTimelineClipMute,
} from "../../timeline/api";

export function muteSourceClipAudio(clipId: string): void {
  const clip = getTimelineClipById(clipId);
  if (!clip || clip.type === "mask" || clip.isMuted === true) {
    return;
  }

  toggleTimelineClipMute(clipId);
}

export function insertExtractedAudioClipBelowSource(
  sourceClip: TimelineClip,
  extractedAudioAsset: Asset,
): string | null {
  const [clipId] = addTimelineClipsOnNewTracksBelow(
    sourceClip.trackId,
    [
      {
        trackLabel: `${sourceClip.name} Audio`,
        trackType: "audio",
        createClip: (trackId) => {
          const baseClip = createTimelineClipFromAsset(extractedAudioAsset);
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
