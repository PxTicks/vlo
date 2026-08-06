import type { FrameSnapMode } from "./frameGrid";
import { TICKS_PER_SECOND } from "./constants";

/**
 * A decoder track's timestamp bounds. Mediabunny's `computeDuration()` returns
 * the end timestamp of the last packet, not the span from the first packet.
 */
export interface MediaTimestampRange {
  readonly firstTimestampSeconds: number;
  readonly endTimestampSeconds: number;
  readonly durationSeconds: number;
}

/** Structural decoder seam so core time does not depend on Mediabunny types. */
export interface MediaTimestampSource {
  getFirstTimestamp(): Promise<number>;
  computeDuration(): Promise<number>;
}

const TICK_EPSILON = 1e-6;

/** Tick -> media seconds (exact rational; the only tick/seconds divide). */
export function tickToMediaSeconds(tick: number): number {
  return tick / TICKS_PER_SECOND;
}

/**
 * Media seconds -> integer tick, with an explicit rounding mode. Use this when
 * a value crossing back from the media domain must re-enter the tick domain.
 */
export function mediaSecondsToTick(
  seconds: number,
  mode: FrameSnapMode = "nearest",
): number {
  const raw = seconds * TICKS_PER_SECOND;
  const nearest = Math.round(raw);
  if (Math.abs(raw - nearest) <= TICK_EPSILON) return nearest;
  if (mode === "floor") return Math.floor(raw);
  if (mode === "ceil") return Math.ceil(raw);
  return nearest;
}

/** Seconds -> tick without rounding, for continuous clock arithmetic. */
export function mediaSecondsToTickExact(seconds: number): number {
  return seconds * TICKS_PER_SECOND;
}

/** First decodable tick at or after a media timestamp. */
export function mediaTimestampToFirstAvailableTick(seconds: number): number {
  return mediaSecondsToTick(seconds, "ceil");
}

/**
 * Names and validates a decoder timestamp interval. Returns null for malformed
 * metadata while preserving valid zero-length and negative-origin ranges.
 */
export function createMediaTimestampRange(
  firstTimestampSeconds: number,
  endTimestampSeconds: number,
): MediaTimestampRange | null {
  if (
    !Number.isFinite(firstTimestampSeconds) ||
    !Number.isFinite(endTimestampSeconds) ||
    endTimestampSeconds < firstTimestampSeconds
  ) {
    return null;
  }
  return Object.freeze({
    firstTimestampSeconds,
    endTimestampSeconds,
    durationSeconds: endTimestampSeconds - firstTimestampSeconds,
  });
}

/** Reads and normalizes one decoder track's timestamp bounds. */
export async function readMediaTimestampRange(
  source: MediaTimestampSource,
): Promise<MediaTimestampRange | null> {
  // Defer both calls so synchronous decoder throws become settled rejections,
  // then wait for both probes before propagating either failure.
  const [endResult, firstResult] = await Promise.allSettled([
    Promise.resolve().then(() => source.computeDuration()),
    Promise.resolve().then(() => source.getFirstTimestamp()),
  ]);
  if (endResult.status === "rejected") throw endResult.reason;
  if (firstResult.status === "rejected") throw firstResult.reason;
  return createMediaTimestampRange(
    firstResult.value,
    endResult.value,
  );
}

/** Normalized progress of an absolute decoder timestamp through a range. */
export function mediaTimestampRangeProgress(
  timestampSeconds: number,
  range: MediaTimestampRange,
): number {
  if (!Number.isFinite(timestampSeconds) || range.durationSeconds <= 0) return 0;
  return (timestampSeconds - range.firstTimestampSeconds) / range.durationSeconds;
}
