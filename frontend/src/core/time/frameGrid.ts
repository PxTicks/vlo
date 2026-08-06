import { TICKS_PER_SECOND } from "./constants";

/**
 * Canonical, integer-first tick<->frame math. This is the single internal
 * source of truth for the frame grid; media-time seconds live behind the
 * separate core `mediaTime` boundary. Project fps is integer and
 * `TICKS_PER_SECOND` (96000) is divisible by every supported fps, so for the
 * project grid every tick<->frame result is exact in integers. The functions
 * also accept arbitrary (possibly fractional) fps so the same primitives serve
 * source-fps grids (e.g. asset.fps) and the future keyframe-alignment stage.
 */

export type FrameSnapMode = "nearest" | "floor" | "ceil";

/**
 * Tolerance for treating a tick as already sitting on a frame boundary.
 * UNITS: frame indices (the value compared is a frame *count*, `tick / tpf`),
 * NOT ticks. Kept far below one frame so it only absorbs floating-point dust
 * from upstream resolver math — it must never reclassify a genuinely
 * off-grid position.
 */
export const FRAME_INDEX_EPSILON = 1e-6;

function safeTicksPerFrame(ticksPerFrameValue: number): number {
  return ticksPerFrameValue > 1e-6 ? ticksPerFrameValue : 1e-6;
}

/**
 * Core: frame index for a tick on a grid of `ticksPerFrameValue` ticks/frame.
 * Epsilon-tolerant — a tick within `FRAME_INDEX_EPSILON` of a boundary snaps to
 * that boundary regardless of `mode`, so an already-frame-aligned position is
 * never pushed to the next frame by float error (the ceiling linchpin).
 */
export function frameIndexFromTick(
  tick: number,
  ticksPerFrameValue: number,
  mode: FrameSnapMode = "nearest",
): number {
  const tpf = safeTicksPerFrame(ticksPerFrameValue);
  const f = tick / tpf;
  const nearest = Math.round(f);
  if (Math.abs(f - nearest) <= FRAME_INDEX_EPSILON) {
    return nearest;
  }
  if (mode === "floor") return Math.floor(f);
  if (mode === "ceil") return Math.ceil(f);
  return nearest;
}

/** Core: the tick at the start of `frame` on a `ticksPerFrameValue` grid. */
export function tickFromFrameIndex(
  frame: number,
  ticksPerFrameValue: number,
): number {
  return frame * safeTicksPerFrame(ticksPerFrameValue);
}

/** Core: snap a tick to the nearest/floor/ceil frame boundary (in ticks). */
export function snapTickToGrid(
  tick: number,
  ticksPerFrameValue: number,
  mode: FrameSnapMode = "nearest",
): number {
  const tpf = safeTicksPerFrame(ticksPerFrameValue);
  return frameIndexFromTick(tick, tpf, mode) * tpf;
}

/**
 * Ticks per frame for a given fps. Exact integer for every supported project
 * fps; fractional only for fractional source fps. Guards non-finite/<=0 fps.
 */
export function ticksPerFrame(fps: number): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 1;
  return TICKS_PER_SECOND / safeFps;
}

/** fps wrapper around {@link frameIndexFromTick}. */
export function tickToFrame(
  tick: number,
  fps: number,
  mode: FrameSnapMode = "nearest",
): number {
  return frameIndexFromTick(tick, ticksPerFrame(fps), mode);
}

/** fps wrapper around {@link tickFromFrameIndex}. */
export function frameToTick(frame: number, fps: number): number {
  return tickFromFrameIndex(frame, ticksPerFrame(fps));
}

/** fps wrapper around {@link snapTickToGrid}: returns a grid-aligned tick. */
export function snapTickToFrameGrid(
  tick: number,
  fps: number,
  mode: FrameSnapMode = "nearest",
): number {
  return snapTickToGrid(tick, ticksPerFrame(fps), mode);
}
