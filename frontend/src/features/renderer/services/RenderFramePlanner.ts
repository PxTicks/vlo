import type {
  MaskTimelineClip,
  TimelineClip,
} from "../../../types/TimelineTypes";
import type { SourceFrameSyncRef } from "../utils/sourceFrameSync";

/**
 * One visual clip instance that will render at a given output tick, already
 * resolved by the caller: which clip is active on its track, the source frame
 * to show (carrying the `decodeKey`), and the masks that apply to it.
 *
 * The planner consumes these; it does NOT resolve which clip is active. Active-
 * clip resolution stays where it already works (the export loop / live sync),
 * so there remains a single source of truth for "what's active this tick" — the
 * planner only decides how the resulting decodes are shared.
 */
export interface PlannedClipJob {
  trackId: string;
  activeClip: TimelineClip;
  sourceFrame: SourceFrameSyncRef;
  maskClips: MaskTimelineClip[];
}

/**
 * A set of clip jobs that resolve to the *same* decoded source frame (same
 * `decodeKey`): duplicate clips at the same asset/frame/fps/time. Every job in
 * a group can be served by one decode. Groups of size 1 are still groups (one
 * decode, no sharing); groups of size > 1 are where a decode is saved.
 */
export interface DecodeGroup {
  decodeKey: string;
  jobs: PlannedClipJob[];
}

export interface FramePlan {
  /** Every job for the tick, in the order supplied (track/z order). */
  jobs: PlannedClipJob[];
  /**
   * Jobs grouped by shared `decodeKey`, in first-seen order. Jobs whose
   * `sourceFrame.decodeKey` is `null` (text/brush — generated per clip, never a
   * shared asset decode) are intentionally absent: they appear in `jobs` and
   * are decoded engine-locally as today, never deduped.
   */
  decodeGroups: DecodeGroup[];
}

/**
 * Group a tick's resolved clip jobs by the decoded source frame they share.
 *
 * This is the pure decision at the heart of "decode once, share across
 * duplicate clips": within a single tick, the grouping itself is the dedup.
 * (The `SourceFrameDecodeScheduler`'s in-flight coalescing is a separate, finer
 * concern that matters across overlapping async passes — e.g. live playback —
 * not within one synchronous plan.)
 *
 * Pure and side-effect free: it neither decodes nor touches the GPU. Composing
 * this plan with the decode scheduler and the shared texture store — and the
 * engine seam that applies a shared handle instead of decoding — is the
 * integration step that wires the runtime win; it is intentionally not here,
 * because the decode/bitmap lifetime contract (notably: who frees a frame whose
 * jobs all went stale) must be settled against the real decode path, not
 * guessed.
 */
export function planFrameDecodes(jobs: PlannedClipJob[]): FramePlan {
  const groupsByKey = new Map<string, DecodeGroup>();
  const decodeGroups: DecodeGroup[] = [];

  for (const job of jobs) {
    const decodeKey = job.sourceFrame.decodeKey;
    if (!decodeKey) {
      // Text/brush: no shared asset decode. Stays engine-local.
      continue;
    }
    let group = groupsByKey.get(decodeKey);
    if (!group) {
      group = { decodeKey, jobs: [] };
      groupsByKey.set(decodeKey, group);
      decodeGroups.push(group);
    }
    group.jobs.push(job);
  }

  return { jobs, decodeGroups };
}

/**
 * The number of decodes a plan saves versus decoding every job independently:
 * the count of duplicate jobs collapsed into a shared decode. Diagnostics only.
 */
export function countDedupedDecodes(plan: FramePlan): number {
  let saved = 0;
  for (const group of plan.decodeGroups) {
    saved += group.jobs.length - 1;
  }
  return saved;
}
