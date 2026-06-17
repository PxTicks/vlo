import {
  ADJUSTMENT_DEPTH_ALL,
  ADJUSTMENT_RETIMING_STATIC,
  getAdjustmentRetimingMode,
  isAdjustmentDepthAll,
  type AdjustmentDepth,
  type AdjustmentRetimingMode,
  type AdjustmentTimelineClip,
} from "../../../types/TimelineTypes";
import { addClipToDraft, insertTrackIntoDraft } from "./timelineCommands";
import {
  createNewTrack,
  type TimelineModelState,
} from "./timelineTrackModel";

export const generateAdjustmentClipId = (): string =>
  `adj_${crypto.randomUUID()}`;

export interface CreateAdjustmentClipInput {
  /** Optional. When omitted, the helper inserts a fresh adjustment track
   *  at the top of the stack. */
  trackId?: string;
  start: number;
  timelineDuration: number;
  /** Optional. Defaults to the `"all"` sentinel. */
  depth?: AdjustmentDepth;
  /** Optional. Defaults to static/pinned retiming. */
  retimingMode?: AdjustmentRetimingMode;
  name?: string;
}

function isInvalidNumericAdjustmentDepth(depth: AdjustmentDepth): boolean {
  return !isAdjustmentDepthAll(depth) && depth < 1;
}

/**
 * Insert a `"adjustment"`-typed track at `index` (defaults to top of the
 * stack). Returns the new track's id.
 */
export function insertAdjustmentTrackInDraft(
  draft: TimelineModelState,
  index: number = 0,
): string {
  const track = createNewTrack("Adjustment", "adjustment");
  insertTrackIntoDraft(draft, index, track);
  return track.id;
}

/**
 * Create an adjustment clip on `input.trackId` (or a freshly inserted
 * adjustment track if omitted). Returns the new clip's id, or `null` if
 * the inputs were invalid (numeric depth < 1, non-positive duration,
 * negative start) — same no-op + warn shape as the v1 group helpers.
 *
 * Track compatibility happens inside `addClipToDraft`; if the target is a
 * populated incompatible track, that helper rejects and we return null.
 */
export function createAdjustmentClipInDraft(
  draft: TimelineModelState,
  input: CreateAdjustmentClipInput,
): string | null {
  if (input.timelineDuration <= 0) {
    console.warn(
      `[createAdjustmentClipInDraft] rejecting clip: timelineDuration must be > 0 (got ${input.timelineDuration}).`,
    );
    return null;
  }
  if (input.start < 0) {
    console.warn(
      `[createAdjustmentClipInDraft] rejecting clip: start must be ≥ 0 (got ${input.start}).`,
    );
    return null;
  }

  // Resolve target track: either the caller's choice or a fresh adjustment
  // track inserted at the top.
  let trackId = input.trackId;
  if (trackId === undefined) {
    // Reuse an existing adjustment track if there is one — avoids piling
    // up empty adjustment lanes for repeated additions. Picks the
    // top-most adjustment track (lowest index in the stack).
    const existing = draft.tracks.find((t) => t.type === "adjustment");
    trackId = existing?.id ?? insertAdjustmentTrackInDraft(draft, 0);
  }

  const depth = input.depth ?? ADJUSTMENT_DEPTH_ALL;
  if (isInvalidNumericAdjustmentDepth(depth)) {
    console.warn(
      `[createAdjustmentClipInDraft] rejecting clip: depth must be ≥ 1 (got ${depth}).`,
    );
    return null;
  }

  const id = generateAdjustmentClipId();
  const clip: AdjustmentTimelineClip = {
    id,
    type: "adjustment",
    name: input.name ?? "Adjustment",
    trackId,
    start: input.start,
    timelineDuration: input.timelineDuration,
    sourceDuration: input.timelineDuration,
    transformedDuration: input.timelineDuration,
    transformedOffset: 0,
    croppedSourceDuration: input.timelineDuration,
    offset: 0,
    transformations: [],
    depth,
    retimingMode: input.retimingMode ?? ADJUSTMENT_RETIMING_STATIC,
  };

  // Snapshot length before the add — addClipToDraft no-ops on rule-2
  // violation, so we use the post-add length to detect rejection.
  const beforeLength = draft.clips.length;
  addClipToDraft(draft, clip);
  if (draft.clips.length === beforeLength) {
    return null;
  }
  return id;
}

/**
 * Update an existing adjustment clip's `depth`. No-op + warn if the clip
 * doesn't exist, isn't an adjustment clip, or a numeric `depth < 1`. Depth
 * bounds against available tracks below are NOT enforced here — the
 * derivation clamps at render time, so a numeric depth that exceeds the
 * current track stack is harmless and restores reach if the user re-adds
 * tracks below. The `"all"` sentinel keeps following the bottom of the
 * stack automatically.
 */
export function setAdjustmentDepthInDraft(
  draft: TimelineModelState,
  clipId: string,
  depth: AdjustmentDepth,
): boolean {
  if (isInvalidNumericAdjustmentDepth(depth)) {
    console.warn(
      `[setAdjustmentDepthInDraft] rejecting depth ${depth} on clip ${clipId}: must be ≥ 1.`,
    );
    return false;
  }
  const target = draft.clips.find((c) => c.id === clipId);
  if (!target) {
    console.warn(
      `[setAdjustmentDepthInDraft] no clip found with id ${clipId}.`,
    );
    return false;
  }
  if (target.type !== "adjustment") {
    console.warn(
      `[setAdjustmentDepthInDraft] clip ${clipId} is not an adjustment clip (type=${target.type}).`,
    );
    return false;
  }
  draft.clips = draft.clips.map((clip) =>
    clip.id === clipId && clip.type === "adjustment"
      ? { ...clip, depth }
      : clip,
  );
  return true;
}

export function setAdjustmentRetimingModeInDraft(
  draft: TimelineModelState,
  clipId: string,
  retimingMode: AdjustmentRetimingMode,
): boolean {
  const target = draft.clips.find((c) => c.id === clipId);
  if (!target) {
    console.warn(
      `[setAdjustmentRetimingModeInDraft] no clip found with id ${clipId}.`,
    );
    return false;
  }
  if (target.type !== "adjustment") {
    console.warn(
      `[setAdjustmentRetimingModeInDraft] clip ${clipId} is not an adjustment clip (type=${target.type}).`,
    );
    return false;
  }
  if (getAdjustmentRetimingMode(target) === retimingMode) {
    return true;
  }
  draft.clips = draft.clips.map((clip) =>
    clip.id === clipId && clip.type === "adjustment"
      ? { ...clip, retimingMode }
      : clip,
  );
  return true;
}
