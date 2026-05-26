import type {
  ClipTransform,
  TimelineGroup,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import type { TimelineModelState } from "./timelineTrackModel";

export const generateGroupId = (): string => `group_${crypto.randomUUID()}`;

export interface RenderGroupCandidate {
  /** Optional. When present, treats this candidate as an edit of that group
   *  (the candidate is excluded from overlap checks against itself). */
  id?: string;
  trackIds: readonly string[];
  start: number;
  timelineDuration: number;
}

export interface CreateRenderGroupInput {
  id?: string;
  label?: string;
  trackIds: readonly string[];
  start: number;
  timelineDuration: number;
  isVisible?: boolean;
  isCollapsed?: boolean;
  transformations?: ClipTransform[];
}

function getVisualTrackIndexMap(
  tracks: readonly TimelineTrack[],
): Map<string, number> {
  const map = new Map<string, number>();
  let visualIndex = 0;
  for (const track of tracks) {
    if (track.type === undefined || track.type === "visual") {
      map.set(track.id, visualIndex);
      visualIndex += 1;
    }
  }
  return map;
}

function rangesOverlap(
  aStart: number,
  aDuration: number,
  bStart: number,
  bDuration: number,
): boolean {
  return aStart < bStart + bDuration && bStart < aStart + aDuration;
}

/**
 * Invariant 1: no two groups may be simultaneously active over the same track.
 * Returns true when the candidate respects the invariant against `state.groups`.
 */
export function isGroupOverlapValid(
  state: { groups: readonly TimelineGroup[] },
  candidate: RenderGroupCandidate,
): boolean {
  const candidateTrackIds = new Set(candidate.trackIds);
  for (const group of state.groups) {
    if (group.id === candidate.id) continue;
    const sharesTracks = group.trackIds.some((id) =>
      candidateTrackIds.has(id),
    );
    if (!sharesTracks) continue;
    if (
      rangesOverlap(
        candidate.start,
        candidate.timelineDuration,
        group.start,
        group.timelineDuration,
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Invariant 2: a group's trackIds must form a contiguous run in the project's
 * visual-track order. A single Pixi container holding the group's tracks can
 * only occupy a contiguous z-band on logicalStage.
 */
export function isGroupTrackRangeContiguous(
  state: { tracks: readonly TimelineTrack[] },
  candidate: { trackIds: readonly string[] },
): boolean {
  if (candidate.trackIds.length === 0) return false;
  const indexMap = getVisualTrackIndexMap(state.tracks);
  const indices: number[] = [];
  for (const id of candidate.trackIds) {
    const idx = indexMap.get(id);
    if (idx === undefined) return false;
    indices.push(idx);
  }
  const sorted = [...indices].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] !== sorted[i - 1] + 1) return false;
  }
  return true;
}

/**
 * Sort `trackIds` into the project's visual-track order (top-to-bottom). The
 * validator accepts any input order; on write we normalise so consumers
 * (renderer, UI) can rely on a canonical traversal. Caller must have already
 * passed isGroupTrackRangeContiguous, so every id resolves to a visual index.
 */
function normalizeTrackIdsToVisualOrder(
  state: { tracks: readonly TimelineTrack[] },
  trackIds: readonly string[],
): string[] {
  const indexMap = getVisualTrackIndexMap(state.tracks);
  return [...trackIds].sort((a, b) => {
    const ai = indexMap.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bi = indexMap.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

function makeGroup(
  input: CreateRenderGroupInput,
  normalizedTrackIds: string[],
): TimelineGroup {
  return {
    id: input.id ?? generateGroupId(),
    label: input.label ?? "Group",
    trackIds: normalizedTrackIds,
    start: input.start,
    timelineDuration: input.timelineDuration,
    transformations: input.transformations ?? [],
    isVisible: input.isVisible ?? true,
    isCollapsed: input.isCollapsed,
  };
}

export function createGroupInDraft(
  draft: TimelineModelState,
  input: CreateRenderGroupInput,
): TimelineGroup | null {
  if (input.trackIds.length === 0) {
    console.warn("[renderGroupCommands] createGroup: trackIds is empty.");
    return null;
  }
  if (input.timelineDuration <= 0) {
    console.warn(
      "[renderGroupCommands] createGroup: timelineDuration must be > 0.",
    );
    return null;
  }
  if (input.start < 0) {
    console.warn("[renderGroupCommands] createGroup: start must be >= 0.");
    return null;
  }
  if (input.id !== undefined && draft.groups.some((g) => g.id === input.id)) {
    console.warn(
      `[renderGroupCommands] createGroup: id '${input.id}' already exists.`,
    );
    return null;
  }
  // Crucial: for create, omit `id` from the overlap candidate so the check
  // applies against every existing group. (isGroupOverlapValid skips matching
  // ids for edit-helpers; reusing that here would let a caller smuggle in a
  // duplicate id past the main invariant.)
  const candidate: RenderGroupCandidate = {
    trackIds: input.trackIds,
    start: input.start,
    timelineDuration: input.timelineDuration,
  };
  if (!isGroupTrackRangeContiguous(draft, candidate)) {
    console.warn(
      "[renderGroupCommands] createGroup: trackIds must form a contiguous visual-track range.",
    );
    return null;
  }
  if (!isGroupOverlapValid(draft, candidate)) {
    console.warn(
      "[renderGroupCommands] createGroup: would activate two groups over the same track.",
    );
    return null;
  }
  const normalizedTrackIds = normalizeTrackIdsToVisualOrder(
    draft,
    input.trackIds,
  );
  const group = makeGroup(input, normalizedTrackIds);
  draft.groups.push(group);
  return group;
}

export function deleteGroupFromDraft(
  draft: TimelineModelState,
  groupId: string,
): boolean {
  const before = draft.groups.length;
  draft.groups = draft.groups.filter((group) => group.id !== groupId);
  return draft.groups.length !== before;
}

export function setGroupTrackIdsInDraft(
  draft: TimelineModelState,
  groupId: string,
  trackIds: readonly string[],
): boolean {
  const group = draft.groups.find((g) => g.id === groupId);
  if (!group) return false;
  if (trackIds.length === 0) {
    console.warn(
      "[renderGroupCommands] setGroupTrackIds: trackIds is empty.",
    );
    return false;
  }
  const candidate: RenderGroupCandidate = {
    id: groupId,
    trackIds,
    start: group.start,
    timelineDuration: group.timelineDuration,
  };
  if (!isGroupTrackRangeContiguous(draft, candidate)) {
    console.warn(
      "[renderGroupCommands] setGroupTrackIds: trackIds must form a contiguous visual-track range.",
    );
    return false;
  }
  if (!isGroupOverlapValid(draft, candidate)) {
    console.warn(
      "[renderGroupCommands] setGroupTrackIds: would conflict with another group's window.",
    );
    return false;
  }
  group.trackIds = normalizeTrackIdsToVisualOrder(draft, trackIds);
  return true;
}

export function setGroupTimeRangeInDraft(
  draft: TimelineModelState,
  groupId: string,
  start: number,
  timelineDuration: number,
): boolean {
  const group = draft.groups.find((g) => g.id === groupId);
  if (!group) return false;
  if (timelineDuration <= 0) {
    console.warn(
      "[renderGroupCommands] setGroupTimeRange: timelineDuration must be > 0.",
    );
    return false;
  }
  if (start < 0) {
    console.warn(
      "[renderGroupCommands] setGroupTimeRange: start must be >= 0.",
    );
    return false;
  }
  const candidate: RenderGroupCandidate = {
    id: groupId,
    trackIds: group.trackIds,
    start,
    timelineDuration,
  };
  if (!isGroupOverlapValid(draft, candidate)) {
    console.warn(
      "[renderGroupCommands] setGroupTimeRange: would conflict with another group's window.",
    );
    return false;
  }
  group.start = start;
  group.timelineDuration = timelineDuration;
  return true;
}

export function setGroupVisibilityInDraft(
  draft: TimelineModelState,
  groupId: string,
  isVisible: boolean,
): boolean {
  const group = draft.groups.find((g) => g.id === groupId);
  if (!group) return false;
  group.isVisible = isVisible;
  return true;
}

export function setGroupTransformationsInDraft(
  draft: TimelineModelState,
  groupId: string,
  transformations: ClipTransform[],
): boolean {
  const group = draft.groups.find((g) => g.id === groupId);
  if (!group) return false;
  group.transformations = transformations;
  return true;
}

/**
 * Drop any group `trackIds` that no longer reference live tracks. Empty groups
 * are *kept* (UI shows the group and lets the user delete explicitly).
 */
export function pruneOrphanedGroupTrackIds(
  draft: TimelineModelState,
): void {
  if (draft.groups.length === 0) return;
  const liveTrackIds = new Set(draft.tracks.map((t) => t.id));
  for (const group of draft.groups) {
    const next = group.trackIds.filter((id) => liveTrackIds.has(id));
    if (next.length !== group.trackIds.length) {
      group.trackIds = next;
    }
  }
}
