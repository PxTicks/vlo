import type { BaseClip, TextClipData } from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../timeline";
import { TEXT_DEFAULT_DURATION_SECONDS } from "../constants";
import { deriveTextClipName, resolveTextClipData } from "./textClipData";

export function createTextClip(
  textOverrides: Partial<TextClipData> = {},
): BaseClip & { type: "text"; textData: TextClipData } {
  const textData = resolveTextClipData(textOverrides);
  const durationTicks = TEXT_DEFAULT_DURATION_SECONDS * TICKS_PER_SECOND;

  return {
    id: `clip_${crypto.randomUUID()}`,
    type: "text",
    name: deriveTextClipName(textData.content),
    sourceDuration: null,
    timelineDuration: durationTicks,
    croppedSourceDuration: durationTicks,
    offset: 0,
    transformations: [],
    transformedDuration: durationTicks,
    transformedOffset: 0,
    textData,
  };
}
