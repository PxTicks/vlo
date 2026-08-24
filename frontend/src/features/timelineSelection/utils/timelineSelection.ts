import type {
  TimelineClip,
  TimelineSelection,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { snapTickToGrid } from "../../../core/time/frameGrid";
import type { FrameSnapMode } from "../../../core/time/frameGrid";

export type { FrameSnapMode };
export { getTicksPerFrame } from "../../../core/time/ticksPerFrame";

const MIN_FPS = 1;
const MIN_FRAME_STEP = 1;
const DEFAULT_FRAME_OFFSET = 1;

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

/**
 * Phase of the frame-count grid: the smallest valid frame count, and the
 * remainder every larger one leaves. Workflows that need
 * `frameStep * n + frameOffset` frames (MiniMax H3's 17k + 5, for example)
 * declare it; everything else stays on the historical `frameStep * n + 1`.
 */
export function resolveSelectionFrameOffset(
  selection: { frameOffset?: number | null } | null | undefined,
): number {
  return clampToPositiveInteger(selection?.frameOffset, DEFAULT_FRAME_OFFSET);
}

export function snapTickToFrame(tick: number, ticksPerFrame: number): number {
  return snapTickToGrid(tick, ticksPerFrame, "nearest");
}

export function snapFrameCountToStep(
  frameCount: number,
  frameStep: number,
  mode: FrameSnapMode = "nearest",
  frameOffset: number = DEFAULT_FRAME_OFFSET,
): number {
  const safeFrameCount = Math.max(1, frameCount);
  const safeFrameStep = clampToPositiveInteger(frameStep, MIN_FRAME_STEP);
  const safeFrameOffset = clampToPositiveInteger(
    frameOffset,
    DEFAULT_FRAME_OFFSET,
  );

  if (safeFrameStep <= 1) {
    const rounded =
      mode === "floor"
        ? Math.floor(safeFrameCount)
        : mode === "ceil"
          ? Math.ceil(safeFrameCount)
          : Math.round(safeFrameCount);
    return Math.max(safeFrameOffset, rounded);
  }

  const normalized = (safeFrameCount - safeFrameOffset) / safeFrameStep;
  const snappedUnits =
    mode === "floor"
      ? Math.floor(normalized)
      : mode === "ceil"
        ? Math.ceil(normalized)
        : Math.round(normalized);

  return Math.max(
    safeFrameOffset,
    snappedUnits * safeFrameStep + safeFrameOffset,
  );
}

export interface SnapSteppedRangeEdgeOptions {
  edge: "start" | "end";
  proposedTick: number;
  fixedTick: number;
  ticksPerFrame: number;
  frameStep: number;
  /** Grid phase: valid frame counts are `frameStep * n + frameOffset`. */
  frameOffset?: number;
  mode?: FrameSnapMode;
  minTick?: number;
  maxTick?: number;
  maxFrameCount?: number | null;
}

/**
 * Resolves one moving range edge onto the shared `frameStep * n + frameOffset`
 * grid while preserving the opposite edge and respecting optional range limits.
 *
 * Returns null when the room between the anchor and the limits cannot hold even
 * the smallest valid frame count (`frameOffset`). Callers must reject the move
 * rather than fall back to a bounded tick: clamping there would hand back a
 * range whose frame count is off-grid, which is exactly what the workflow's
 * grid forbids.
 */
export function snapSteppedRangeEdge({
  edge,
  proposedTick,
  fixedTick,
  ticksPerFrame,
  frameStep,
  frameOffset = DEFAULT_FRAME_OFFSET,
  mode = "nearest",
  minTick = 0,
  maxTick = Number.POSITIVE_INFINITY,
  maxFrameCount = null,
}: SnapSteppedRangeEdgeOptions): number | null {
  const safeTicksPerFrame =
    Number.isFinite(ticksPerFrame) && ticksPerFrame > 0 ? ticksPerFrame : 1;
  const lowerEdge = edge === "start" ? minTick : fixedTick + safeTicksPerFrame;
  const upperEdge =
    edge === "start" ? fixedTick - safeTicksPerFrame : maxTick;
  const boundedTick = Math.max(lowerEdge, Math.min(upperEdge, proposedTick));
  const rawFrameCount =
    edge === "start"
      ? (fixedTick - boundedTick) / safeTicksPerFrame
      : (boundedTick - fixedTick) / safeTicksPerFrame;
  // The grid's smallest valid count is its offset. When neither the room to the
  // limit nor an explicit cap can hold that many frames, no tick represents a
  // valid range: snapping would return the offset anyway and the final clamp
  // would silently hand back an off-grid range at the boundary.
  const smallestValidFrameCount = clampToPositiveInteger(
    frameOffset,
    DEFAULT_FRAME_OFFSET,
  );
  const availableFrameCount =
    edge === "start"
      ? (fixedTick - minTick) / safeTicksPerFrame
      : (maxTick - fixedTick) / safeTicksPerFrame;
  if (
    (Number.isFinite(availableFrameCount) &&
      availableFrameCount < smallestValidFrameCount) ||
    (maxFrameCount !== null &&
      Number.isFinite(maxFrameCount) &&
      maxFrameCount < smallestValidFrameCount)
  ) {
    return null;
  }

  let frameCount = snapFrameCountToStep(
    rawFrameCount,
    frameStep,
    mode,
    frameOffset,
  );

  if (maxFrameCount !== null && Number.isFinite(maxFrameCount)) {
    frameCount = Math.min(frameCount, Math.max(1, maxFrameCount));
  }

  if (Number.isFinite(availableFrameCount)) {
    frameCount = Math.min(
      frameCount,
      snapFrameCountToStep(
        availableFrameCount,
        frameStep,
        "floor",
        frameOffset,
      ),
    );
  }

  const resolvedTick =
    edge === "start"
      ? fixedTick - frameCount * safeTicksPerFrame
      : fixedTick + frameCount * safeTicksPerFrame;
  return Math.max(minTick, Math.min(maxTick, resolvedTick));
}

type SubordinateClipReferenceRole = "mask";

interface SubordinateClipReference {
  clipId: string;
  role: SubordinateClipReferenceRole;
}

/**
 * Central place for component-level child clip references.
 *
 * Saved selections often preserve the parent clip plus its component metadata
 * but omit the subordinate clip records those components point at. Keep new
 * clip-backed attachments wired into this helper so render/export selection
 * normalization stays generic instead of accreting mask-specific fixes.
 */
function collectSubordinateClipReferences(
  clip: TimelineClip,
): SubordinateClipReference[] {
  if (clip.type === "mask") {
    return [];
  }

  const references: SubordinateClipReference[] = [];

  for (const component of clip.components ?? []) {
    if (component.type !== "mask_ref") {
      continue;
    }

    const { maskClipId } = component.parameters;
    if (typeof maskClipId !== "string" || maskClipId.trim().length === 0) {
      continue;
    }

    references.push({
      clipId: maskClipId,
      role: "mask",
    });
  }

  return references;
}

export function getReferencedSubordinateClipIds(
  clips: readonly TimelineClip[],
): string[] {
  const clipIds = new Set<string>();
  for (const clip of clips) {
    for (const reference of collectSubordinateClipReferences(clip)) {
      clipIds.add(reference.clipId);
    }
  }
  return [...clipIds];
}

function clipReferencesMask(clip: TimelineClip): boolean {
  return collectSubordinateClipReferences(clip).some(
    (reference) => reference.role === "mask",
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
  const referencedSubordinateClipIds = new Set<string>();

  for (const clip of includedPrimaryClips) {
    for (const reference of collectSubordinateClipReferences(clip)) {
      referencedSubordinateClipIds.add(reference.clipId);
    }
  }

  return availableClips.filter(
    (clip) =>
      includedTrackIdSet.has(clip.trackId) ||
      referencedSubordinateClipIds.has(clip.id),
  );
}

function recoverReferencedSubordinateClips(
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
  const recoveredClips: TimelineClip[] = [];

  for (const clip of clips) {
    for (const reference of collectSubordinateClipReferences(clip)) {
      if (clipIds.has(reference.clipId)) {
        continue;
      }

      const referencedClip = availableClipsById.get(reference.clipId);
      if (!referencedClip) {
        continue;
      }

      clipIds.add(referencedClip.id);
      recoveredClips.push(referencedClip);
    }
  }

  return recoveredClips.length > 0 ? [...clips, ...recoveredClips] : clips;
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
  const availableTracks = Array.isArray(selection.tracks)
    ? selection.tracks
    : [];
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
      ? recoverReferencedSubordinateClips(validClips, availableClips)
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

/**
 * Sanitizes a detached/persisted selection without consulting the open
 * timeline. Missing clips stay missing so replay cannot silently substitute
 * newer live clip state for the saved snapshot.
 */
export function normalizeDetachedTimelineSelection(
  selection: TimelineSelection,
): TimelineSelection {
  return normalizeTimelineSelection(selection);
}
