import { TICKS_PER_SECOND } from "../../../core/time/constants";
import type { FrameSnapMode } from "../../../core/time/frameGrid";
import { calculateClipTime } from "../../transformations/utils/timeCalculation";
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

/**
 * Tolerance (in ticks) for treating a seconds value as sitting exactly on an
 * integer tick. Absorbs the floating-point dust from `tick / TICKS_PER_SECOND *
 * TICKS_PER_SECOND` round-trips (~1e-10 even on multi-million-tick timelines)
 * while staying far below one whole tick.
 */
const TICK_EPSILON = 1e-6;

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
  // Epsilon-tolerant: a value within floating-point dust of an integer tick is
  // treated as ON that tick, so floor/ceil never drift a whole tick on
  // tick-derived seconds — e.g. tickToMediaSeconds(7) * TICKS_PER_SECOND ===
  // 7.000000000000001 must ceil to 7, not 8. Mirrors frameGrid's epsilon-
  // tolerant frame ceiling, but in tick units (TICK_EPSILON << 1 tick, and far
  // above the ~1e-10 dust even for multi-million-tick timelines).
  const nearest = Math.round(raw);
  if (Math.abs(raw - nearest) <= TICK_EPSILON) return nearest;
  if (mode === "floor") return Math.floor(raw);
  if (mode === "ceil") return Math.ceil(raw);
  return nearest;
}

/**
 * seconds -> tick WITHOUT rounding (keeps fractional ticks). For continuous
 * clock arithmetic — the audio/playback clock represents time as fractional
 * ticks and must not be quantized to integers (that would jitter sync). Use
 * {@link mediaSecondsToTick} (rounded) for integer *timeline decisions*; use
 * this for clock math. Exact inverse of {@link tickToMediaSeconds}.
 */
export function mediaSecondsToTickExact(seconds: number): number {
  return seconds * TICKS_PER_SECOND;
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
