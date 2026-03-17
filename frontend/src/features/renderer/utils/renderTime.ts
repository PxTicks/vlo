import { TICKS_PER_SECOND } from "../../timeline";
import { calculateClipTime } from "../../transformations";
import type { TimelineClip } from "../../../types/TimelineTypes";

/**
 * Calculates the local time in seconds for the player/audio engine to seek to.
 *
 * @param clip The clip being rendered
 * @param globalTimeTicks The current global timeline position in ticks
 * @returns Local time in seconds (relative to the start of the asset)
 */
export function calculatePlayerFrameTime(
  clip: TimelineClip,
  globalTimeTicks: number,
): number {
  const effectiveDuration = calculateClipTime(
    clip,
    globalTimeTicks - clip.start,
  );

  // FIX: effectiveDuration (from calculateClipTime) ALREADY includes the offset.
  // Adding it again resulted in double-offsetting.
  return effectiveDuration / TICKS_PER_SECOND;
}

/**
 * Snap a clip-local decode time to the nearest frame boundary for the given FPS.
 * This keeps content and mask-video sampling on the same presentation grid.
 */
export function snapFrameTimeSeconds(
  timeSeconds: number,
  fps: number,
): number {
  const safeTime = Math.max(0, timeSeconds);
  const safeFps =
    typeof fps === "number" && Number.isFinite(fps) && fps > 0 ? fps : 1;
  return Math.round(safeTime * safeFps) / safeFps;
}
