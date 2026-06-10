import type { TimelineClip } from "../../../types/TimelineTypes";
import {
  clipVisualToSourceTime,
  presentationToClipSourceTime,
  type ClipPresentationContext,
} from "../../transformations";

export function toClipInputTimeTicks(
  parentClip: TimelineClip,
  globalTimeTicks: number,
  presentationContext?: ClipPresentationContext,
): number {
  if (presentationContext) {
    return Math.max(
      0,
      presentationToClipSourceTime(
        presentationContext,
        parentClip,
        globalTimeTicks,
      ),
    );
  }

  const clampedGlobalTimeTicks = Math.max(
    parentClip.start,
    Math.min(globalTimeTicks, parentClip.start + parentClip.timelineDuration),
  );
  const currentInputTimeTicks = clipVisualToSourceTime(
    parentClip,
    clampedGlobalTimeTicks - parentClip.start,
  );
  return Math.max(0, currentInputTimeTicks);
}
