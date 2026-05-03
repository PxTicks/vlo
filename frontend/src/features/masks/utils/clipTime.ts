import type { TimelineClip } from "../../../types/TimelineTypes";
import { calculateClipTime } from "../../transformations";

export function toClipInputTimeTicks(
  parentClip: TimelineClip,
  globalTimeTicks: number,
): number {
  const clampedGlobalTimeTicks = Math.max(
    parentClip.start,
    Math.min(globalTimeTicks, parentClip.start + parentClip.timelineDuration),
  );
  const localVisualTimeTicks = clampedGlobalTimeTicks - parentClip.start;
  const currentInputTimeTicks = calculateClipTime(
    parentClip,
    localVisualTimeTicks,
    true,
  );
  return Math.max(0, currentInputTimeTicks);
}
