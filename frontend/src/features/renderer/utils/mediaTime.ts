import {
  mediaSecondsToTickExact,
  tickToMediaSeconds,
} from "../../../core/time/mediaTime";
import { calculateClipTime } from "../../transformations/utils/timeCalculation";
import type { TimelineClip } from "../../../types/TimelineTypes";

export {
  createMediaTimestampRange,
  mediaSecondsToTick,
  mediaSecondsToTickExact,
  mediaTimestampRangeProgress,
  mediaTimestampToFirstAvailableTick,
  readMediaTimestampRange,
  tickToMediaSeconds,
} from "../../../core/time/mediaTime";
export type {
  MediaTimestampRange,
  MediaTimestampSource,
} from "../../../core/time/mediaTime";

/**
 * Renderer-specific media-time helpers. Generic integer ticks / decoder
 * timestamp range semantics live in `core/time/mediaTime`; this module keeps
 * renderer clip/source-frame mappings and compatibility re-exports.
 *
 * Policy:
 * - Ticks and frame indices are the internal currency for every timeline
 *   decision (selection, collision, layout, length).
 * - Seconds appear only at the core boundary or in these renderer-specific
 *   external media adapters.
 * - Never persist or accumulate a media-seconds float and feed it back into a
 *   timeline decision — round-trip through these helpers instead.
 *
 * Every Mediabunny call site should obtain its seconds through the core module
 * or these renderer-specific helpers.
 */

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

export interface RenderedSourceFrameReference {
  frameIndex: number;
  timeSeconds: number;
  timeTicks: number;
}

function safeFrameRate(fps: number): number {
  return typeof fps === "number" && Number.isFinite(fps) && fps > 0 ? fps : 1;
}

function clampFrameIndex(frameIndex: number, frameCount?: number): number {
  const lowerBounded = Math.max(0, frameIndex);
  if (
    typeof frameCount !== "number" ||
    !Number.isFinite(frameCount) ||
    frameCount <= 0
  ) {
    return lowerBounded;
  }
  return Math.min(frameCount - 1, lowerBounded);
}

/**
 * Source-frame identity for the frame the renderer will visibly sample.
 *
 * This intentionally mirrors the player/export path:
 * `sourceTime -> snapFrameTimeSeconds(..., sourceFps) -> frame index`.
 * Consumers that attach source-time-owned edits (SAM2 points, cached masks)
 * should compare this frame identity rather than comparing continuous ticks.
 */
export function getRenderedSourceFrameReferenceFromSeconds(
  timeSeconds: number,
  fps: number,
  frameCount?: number,
): RenderedSourceFrameReference {
  const safeFps = safeFrameRate(fps);
  const snappedTimeSeconds = snapFrameTimeSeconds(timeSeconds, safeFps);
  const frameEpsilonSeconds = 1 / (safeFps * 1_000_000);
  const frameIndex = clampFrameIndex(
    Math.floor((snappedTimeSeconds + frameEpsilonSeconds) * safeFps),
    frameCount,
  );
  const canonicalTimeSeconds = frameIndex / safeFps;
  return {
    frameIndex,
    timeSeconds: canonicalTimeSeconds,
    timeTicks: mediaSecondsToTickExact(canonicalTimeSeconds),
  };
}

export function getRenderedSourceFrameReferenceFromTicks(
  timeTicks: number,
  fps: number,
  frameCount?: number,
): RenderedSourceFrameReference {
  return getRenderedSourceFrameReferenceFromSeconds(
    tickToMediaSeconds(timeTicks),
    fps,
    frameCount,
  );
}
