import { ticksPerFrame } from "./frameGrid";

const MIN_FPS = 1;

function clampToPositiveInteger(
  value: number | null | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.round(value));
}

/**
 * Ticks per frame for an integer fps. Selection/project fps is integer; this
 * preserves the integer clamp, then routes the division through the canonical
 * {@link ticksPerFrame} so there is one source of truth.
 */
export function getTicksPerFrame(fps: number): number {
  return ticksPerFrame(clampToPositiveInteger(fps, MIN_FPS));
}
