import type {
  TimelineClip,
  TimelineSelection,
} from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../timeline";

export type FrameSnapMode = "nearest" | "floor" | "ceil";

const MIN_FPS = 1;
const MIN_FRAME_STEP = 1;

function clampToPositiveInteger(
  value: number | null | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.round(value));
}

export function resolveSelectionFps(
  selection: { fps?: number | null } | null | undefined,
  projectFps: number,
): number {
  const fallback = clampToPositiveInteger(projectFps, MIN_FPS);
  return clampToPositiveInteger(selection?.fps, fallback);
}

export function resolveSelectionFrameStep(
  selection: { frameStep?: number | null } | null | undefined,
): number {
  return clampToPositiveInteger(selection?.frameStep, MIN_FRAME_STEP);
}

export function getTicksPerFrame(fps: number): number {
  const safeFps = clampToPositiveInteger(fps, MIN_FPS);
  return TICKS_PER_SECOND / safeFps;
}

export function snapTickToFrame(tick: number, ticksPerFrame: number): number {
  const safeTicksPerFrame = Math.max(1e-6, ticksPerFrame);
  return Math.round(tick / safeTicksPerFrame) * safeTicksPerFrame;
}

export function snapFrameCountToStep(
  frameCount: number,
  frameStep: number,
  mode: FrameSnapMode = "nearest",
): number {
  const safeFrameCount = Math.max(1, frameCount);
  const safeFrameStep = clampToPositiveInteger(frameStep, MIN_FRAME_STEP);

  if (safeFrameStep <= 1) {
    if (mode === "floor") return Math.max(1, Math.floor(safeFrameCount));
    if (mode === "ceil") return Math.max(1, Math.ceil(safeFrameCount));
    return Math.max(1, Math.round(safeFrameCount));
  }

  const normalized = (safeFrameCount - 1) / safeFrameStep;
  const snappedUnits =
    mode === "floor"
      ? Math.floor(normalized)
      : mode === "ceil"
        ? Math.ceil(normalized)
        : Math.round(normalized);

  return Math.max(1, snappedUnits * safeFrameStep + 1);
}

/**
 * Returns a subset of the timeline clip array that intersects with the given selection.
 * Including all clips and masks.
 */
export function getClipsInSelection(
  clips: TimelineClip[],
  selection: TimelineSelection,
): TimelineClip[] {
  return clips.filter((clip) => {
    const clipStart = clip.start;
    const clipEnd = clip.start + clip.timelineDuration;

    if (selection.end === undefined) {
      return clipStart <= selection.start && selection.start < clipEnd;
    }

    const maxStart = Math.max(clipStart, selection.start);
    const minEnd = Math.min(clipEnd, selection.end);
    return maxStart < minEnd;
  });
}
