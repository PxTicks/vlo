import { PIXELS_PER_SECOND, TICKS_PER_SECOND } from "./constants";

/**
 * Canonical tick<->pixel conversions for timeline layout.
 *
 * This is a SEPARATE domain from `frameGrid` (tick<->frame) and `mediaTime`
 * (tick<->seconds): it bakes in the on-screen scale (`PIXELS_PER_SECOND`) and a
 * layout `zoom` (1 = base). Centralizing it here means timeline UI never
 * open-codes `TICKS_PER_SECOND` / `PIXELS_PER_SECOND` arithmetic, so the
 * conversion guard can cover those files instead of globally exempting them.
 *
 * `zoom` is the timeline zoom scale; pixels-per-second = `PIXELS_PER_SECOND *
 * zoom`. These helpers are pure (no store access) so callers can convert at any
 * zoom — the live view zoom, or a quantized cache level (e.g. thumbnail
 * `bucketZoom`).
 */

function safeZoom(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/** Pixels per second at a given zoom. */
export function pixelsPerSecond(zoom: number): number {
  return PIXELS_PER_SECOND * safeZoom(zoom);
}

/** Ticks spanned by one on-screen pixel at `zoom`. */
export function ticksPerPixel(zoom: number): number {
  return TICKS_PER_SECOND / pixelsPerSecond(zoom);
}

/** Tick span -> on-screen pixels at `zoom`. */
export function ticksToPx(ticks: number, zoom: number): number {
  return (ticks / TICKS_PER_SECOND) * pixelsPerSecond(zoom);
}

/** On-screen pixels -> tick span at `zoom` (unrounded; round at the call site). */
export function pxToTicks(px: number, zoom: number): number {
  return px * ticksPerPixel(zoom);
}
