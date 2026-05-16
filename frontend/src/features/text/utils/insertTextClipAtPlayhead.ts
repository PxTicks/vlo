import type { TextClipData } from "../../../types/TimelineTypes";
import { useProjectStore } from "../../project/useProjectStore";
import { playbackClock } from "../../player/services/PlaybackClock";
import { insertBaseClipAtTime, useTimelineStore } from "../../timeline";
import { getTicksPerFrame, snapTickToFrame } from "../../timelineSelection";
import { createTextClip } from "./createTextClip";

function snapPlayheadToFrame(): number {
  const fps = useProjectStore.getState().config.fps;
  const ticksPerFrame = getTicksPerFrame(fps);
  return snapTickToFrame(playbackClock.time, ticksPerFrame);
}

export function insertTextClipAtPlayhead(
  textOverrides: Partial<TextClipData> = {},
): string | null {
  const clipStart = Math.max(0, snapPlayheadToFrame());
  const baseClip = createTextClip(textOverrides);
  const clipId = insertBaseClipAtTime(baseClip, clipStart);

  if (!clipId) {
    return null;
  }

  useTimelineStore.getState().selectClip(clipId);
  return clipId;
}
