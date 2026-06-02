import { TICKS_PER_SECOND } from "../../timeline";
import type { FrameSnapMode } from "../../timeline";
import { calculateClipTime } from "../../transformations";
import type { TimelineClip } from "../../../types/TimelineTypes";

/**
 * The media-time boundary: the single place where internal integer ticks /
 * frame indices are converted to and from the float seconds that mediabunny
 * (and the Web Audio clock) speak.
 *
 * Policy:
 * - Ticks and frame indices are the internal currency for every timeline
 *   decision (selection, collision, layout, length).
 * - Seconds/ms appear ONLY here, at the external media API edge.
 * - Never persist or accumulate a media-seconds float and feed it back into a
 *   timeline decision — round-trip through these helpers instead.
 *
 * Every mediabunny call site (decoder seek, audio buffer fetch, thumbnail
 * sampling, encoder add) should obtain its seconds from this module.
 */

/** tick -> media seconds (exact rational; the only tick/seconds divide). */
export function tickToMediaSeconds(tick: number): number {
  return tick / TICKS_PER_SECOND;
}

/**
 * media seconds -> integer tick, with an explicit rounding mode. Use this when
 * a value crossing back from the media domain must re-enter the tick domain.
 */
export function mediaSecondsToTick(
  seconds: number,
  mode: FrameSnapMode = "nearest",
): number {
  const raw = seconds * TICKS_PER_SECOND;
  if (mode === "floor") return Math.floor(raw);
  if (mode === "ceil") return Math.ceil(raw);
  return Math.round(raw);
}

/**
 * First decodable tick at or after a media timestamp (ceil). Used when a media
 * timestamp must map to "the first available frame from here onward".
 */
export function mediaTimestampToFirstAvailableTick(seconds: number): number {
  return mediaSecondsToTick(seconds, "ceil");
}

/**
 * Output (encoder) timestamp for a frame index. Frame-index based and so
 * drift-free and strictly monotonic — never derive an output timestamp from
 * accumulated ticks/seconds.
 */
export function frameIndexToOutputTimestamp(
  frameIndex: number,
  fps: number,
): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 1;
  return frameIndex / safeFps;
}

/**
 * Clip-local decode time in seconds for the player/audio engine to seek to.
 * Resolves the clip's own transform stack (speed/offset) in ticks, then crosses
 * the boundary to seconds once at the end.
 *
 * @param clip The clip being rendered
 * @param globalTimeTicks The current global timeline position in ticks
 * @returns Local time in seconds (relative to the start of the asset)
 */
export function calculatePlayerFrameTime(
  clip: TimelineClip,
  globalTimeTicks: number,
): number {
  // effectiveDuration (from calculateClipTime) ALREADY includes the offset.
  const effectiveDuration = calculateClipTime(
    clip,
    globalTimeTicks - clip.start,
  );
  return tickToMediaSeconds(effectiveDuration);
}

/**
 * Snap a clip-local decode time (seconds) to the nearest source-frame boundary
 * for the given fps. Keeps content and mask-video sampling on the same source
 * grid. Source fps may be fractional, hence this stays in the seconds domain.
 */
export function snapFrameTimeSeconds(timeSeconds: number, fps: number): number {
  const safeTime = Math.max(0, timeSeconds);
  const safeFps =
    typeof fps === "number" && Number.isFinite(fps) && fps > 0 ? fps : 1;
  return Math.round(safeTime * safeFps) / safeFps;
}
