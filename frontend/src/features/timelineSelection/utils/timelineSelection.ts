import type {
  TimelineClip,
  TimelineSelection,
  TimelineTrack,
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

function clipReferencesMask(clip: TimelineClip): boolean {
  if (clip.type === "mask") {
    return false;
  }

  return (clip.components ?? []).some(
    (component) =>
      component.type === "mask_ref" &&
      typeof component.parameters.maskClipId === "string" &&
      component.parameters.maskClipId.trim().length > 0,
  );
}

/**
 * True when the selection contains either explicit mask clips or clips that
 * reference masks. This is only a structural hint: it does not account for
 * active-range windows or final scene occlusion, so generation-time optional
 * mask bypasses should prefer a rendered-output check instead.
 */
export function selectionHasMaskClip(selection: TimelineSelection): boolean {
  return Array.isArray(selection.clips)
    ? selection.clips.some(
        (clip) => clip.type === "mask" || clipReferencesMask(clip),
      )
    : false;
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

function normalizeIncludedTrackIds(
  includedTrackIds: unknown,
  availableTracks: TimelineTrack[],
): string[] {
  if (!Array.isArray(includedTrackIds)) {
    return [];
  }

  const allowedTrackIds =
    availableTracks.length > 0
      ? new Set(availableTracks.map((track) => track.id))
      : null;

  return includedTrackIds.filter((trackId, index, list): trackId is string => {
    if (typeof trackId !== "string" || trackId.trim().length === 0) {
      return false;
    }
    if (list.indexOf(trackId) !== index) {
      return false;
    }
    return allowedTrackIds === null || allowedTrackIds.has(trackId);
  });
}

export function getIncludedTracksForSelection(
  selection: TimelineSelection,
  availableTracks: TimelineTrack[],
): TimelineTrack[] {
  const includedTrackIds = normalizeIncludedTrackIds(
    selection.includedTrackIds,
    availableTracks,
  );
  if (includedTrackIds.length === 0) {
    return availableTracks;
  }

  const includedTrackIdSet = new Set(includedTrackIds);
  return availableTracks.filter((track) => includedTrackIdSet.has(track.id));
}

export function getIncludedClipsForSelection(
  selection: TimelineSelection,
  availableClips: TimelineClip[],
): TimelineClip[] {
  const includedTrackIds = normalizeIncludedTrackIds(
    selection.includedTrackIds,
    selection.tracks ?? [],
  );
  if (includedTrackIds.length === 0) {
    return availableClips;
  }

  const includedTrackIdSet = new Set(includedTrackIds);
  const includedPrimaryClips = availableClips.filter((clip) =>
    includedTrackIdSet.has(clip.trackId),
  );
  const referencedMaskIds = new Set<string>();

  for (const clip of includedPrimaryClips) {
    if (clip.type === "mask") {
      continue;
    }
    for (const component of clip.components ?? []) {
      if (
        component.type === "mask_ref" &&
        typeof component.parameters.maskClipId === "string"
      ) {
        referencedMaskIds.add(component.parameters.maskClipId);
      }
    }
  }

  return availableClips.filter(
    (clip) =>
      includedTrackIdSet.has(clip.trackId) ||
      (clip.type === "mask" && referencedMaskIds.has(clip.id)),
  );
}

function recoverReferencedMaskClips(
  clips: TimelineClip[],
  availableClips: TimelineClip[],
): TimelineClip[] {
  if (clips.length === 0 || availableClips.length === 0) {
    return clips;
  }

  const clipIds = new Set(clips.map((clip) => clip.id));
  const availableClipsById = new Map(
    availableClips.map((clip) => [clip.id, clip] as const),
  );
  const recoveredMaskClips: TimelineClip[] = [];

  for (const clip of clips) {
    if (!clipReferencesMask(clip)) {
      continue;
    }

    for (const component of clip.components ?? []) {
      if (component.type !== "mask_ref") {
        continue;
      }

      const { maskClipId } = component.parameters;
      if (typeof maskClipId !== "string" || clipIds.has(maskClipId)) {
        continue;
      }

      const maskClip = availableClipsById.get(maskClipId);
      if (maskClip?.type !== "mask") {
        continue;
      }

      clipIds.add(maskClip.id);
      recoveredMaskClips.push(maskClip);
    }
  }

  return recoveredMaskClips.length > 0
    ? [...clips, ...recoveredMaskClips]
    : clips;
}

function isTimelineClip(value: unknown): value is TimelineClip {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<TimelineClip>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.start === "number" &&
    typeof candidate.timelineDuration === "number"
  );
}

export function normalizeTimelineSelection(
  selection: TimelineSelection,
  availableClips: TimelineClip[] = [],
): TimelineSelection {
  const rawClips = Array.isArray(selection.clips) ? selection.clips : [];
  const validClips = rawClips.filter(isTimelineClip);
  const availableTracks = Array.isArray(selection.tracks) ? selection.tracks : [];
  const normalizedIncludedTrackIds = normalizeIncludedTrackIds(
    selection.includedTrackIds,
    availableTracks,
  );
  const normalizedMessage =
    typeof selection.message === "string" && selection.message.trim().length > 0
      ? selection.message.trim()
      : null;

  const recoveredClips =
    validClips.length > 0
      ? recoverReferencedMaskClips(validClips, availableClips)
      : availableClips.length > 0
        ? getClipsInSelection(availableClips, {
            ...selection,
            clips: [],
          })
        : validClips;

  const normalizedSelection: TimelineSelection = {
    ...selection,
    clips: recoveredClips,
  };

  if (normalizedMessage) {
    normalizedSelection.message = normalizedMessage;
  } else {
    delete normalizedSelection.message;
  }

  if (normalizedIncludedTrackIds.length > 0) {
    normalizedSelection.includedTrackIds = normalizedIncludedTrackIds;
  } else {
    delete normalizedSelection.includedTrackIds;
  }

  return normalizedSelection;
}
