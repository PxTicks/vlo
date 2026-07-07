import type { TextClipData } from "../../../types/TimelineTypes";
import { useProjectStore } from "../../project/useProjectStore";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import {
  insertTimelineBaseClipAtTime,
  selectTimelineClip,
} from "../../timeline/api";
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
  const clipId = insertTimelineBaseClipAtTime(baseClip, clipStart);

  if (!clipId) {
    return null;
  }

  selectTimelineClip(clipId);
  return clipId;
}
