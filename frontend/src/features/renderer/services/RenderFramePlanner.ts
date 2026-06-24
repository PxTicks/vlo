import type {
  MaskTimelineClip,
  TimelineClip,
} from "../../../types/TimelineTypes";
import type {
  SourceFrameSyncIntent,
  SourceFrameSyncRef,
} from "../utils/sourceFrameSync";
import type { SourceFrameDecodeScheduler } from "./SourceFrameDecodeScheduler";
import type {
  SharedTextureHandle,
  SharedTextureResource,
  SharedTextureStore,
} from "./SharedTextureStore";
import { DecodedFrameClaimArbiter } from "./DecodedFrameClaimArbiter";

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

/**
 * Caller-supplied hooks binding the abstract plan to the real decode/GPU world.
 * Generic over the decoded frame type (`TFrame`, e.g. an `ImageBitmap`) so the
 * planner never assumes a frame representation.
 */
export interface FrameTextureOps<TFrame> {
  /** Decode the one source frame a group needs. Called at most once per group. */
  decode: (group: DecodeGroup) => Promise<TFrame>;
  /**
   * Wrap a decoded frame into a shared texture resource. Called once per group
   * (the store dedupes); its `dispose` must free both the texture and the
   * frame (e.g. destroy the texture and close the bitmap).
   */
  createResource: (decodeKey: string, frame: TFrame) => SharedTextureResource;
  /** The job's clip's latest intent, for per-job stale rejection. */
  getCurrentIntent: (job: PlannedClipJob) => SourceFrameSyncIntent | null;
  /**
   * Free a frame that was decoded but claimed by no current job (the whole
   * group went stale), so its bitmap does not leak.
   */
  disposeUnclaimedFrame: (frame: TFrame) => void;
}

/**
 * Composes the plan with the decode scheduler and the shared texture store to
 * realise "decode once, share across duplicate clips" for a single tick.
 *
 * `planFrameDecodes` is the pure grouping; this class turns each group into one
 * decode and one reference-counted texture shared by every current job in the
 * group. The scheduler coalesces the per-job decode requests of a group into a
 * single in-flight decode (and also across overlapping ticks); the store wraps
 * the result once and hands a release-only handle to each current job.
 *
 * Active-clip resolution is the caller's; per the integration contract the
 * engine seam must apply these planned handles directly and must NOT re-resolve
 * the active/effective frame, so one resolution feeds both planning and render.
 */
export class RenderFramePlanner<TFrame> {
  private readonly scheduler: SourceFrameDecodeScheduler<TFrame>;
  private readonly store: SharedTextureStore;
  private readonly claimArbiter = new DecodedFrameClaimArbiter<TFrame>();

  constructor(
    scheduler: SourceFrameDecodeScheduler<TFrame>,
    store: SharedTextureStore,
  ) {
    this.scheduler = scheduler;
    this.store = store;
  }

  plan(jobs: PlannedClipJob[]): FramePlan {
    return planFrameDecodes(jobs);
  }

  /**
   * Resolve one shared texture handle per current job. Jobs whose intent has
   * gone stale are omitted (no handle); a group with no current job has its
   * decoded frame disposed via `ops.disposeUnclaimedFrame`.
   *
   * Overlapping calls are safe: the per-decodeKey claim arbiter coordinates a
   * scheduler result shared by multiple acquisitions so one caller cannot
   * dispose a frame while another is wrapping or using it.
   *
   * On failure the whole acquisition is rolled back: every handle already
   * created is released and any decoded-but-unwrapped frame is disposed, so a
   * partial failure never leaks a texture or a bitmap.
   */
  async acquireFrameTextures(
    plan: FramePlan,
    ops: FrameTextureOps<TFrame>,
  ): Promise<Map<PlannedClipJob, SharedTextureHandle>> {
    const handles = new Map<PlannedClipJob, SharedTextureHandle>();
    try {
      const groupResults = await Promise.allSettled(
        plan.decodeGroups.map((group) => this.acquireGroup(group, ops)),
      );

      let failure: unknown;
      let hasFailure = false;
      for (const result of groupResults) {
        if (result.status === "fulfilled") {
          for (const [job, handle] of result.value) {
            handles.set(job, handle);
          }
        } else if (!hasFailure) {
          hasFailure = true;
          failure = result.reason;
        }
      }

      if (hasFailure) {
        // A group that itself rejected has already released its own handles and
        // disposed its frame; release the ones successful groups produced.
        for (const handle of handles.values()) {
          handle.release();
        }
        throw failure;
      }

      return handles;
    } catch (error) {
      for (const handle of handles.values()) {
        handle.release();
      }
      throw error;
    }
  }

  /**
   * Acquire handles for a single decode group. On any failure it cleans up
   * after itself — releases handles it created and disposes the frame if no
   * store ownership was established — then rethrows for the caller to roll back
   * the rest of the plan.
   */
  private async acquireGroup(
    group: DecodeGroup,
    ops: FrameTextureOps<TFrame>,
  ): Promise<Map<PlannedClipJob, SharedTextureHandle>> {
    const cachedHandles = new Map<PlannedClipJob, SharedTextureHandle>();
    if (this.store.has(group.decodeKey)) {
      for (const job of group.jobs) {
        const expected = {
          key: job.sourceFrame.key,
          generation: job.sourceFrame.generation,
        };
        const current = ops.getCurrentIntent(job);
        if (
          current?.key !== expected.key ||
          current.generation !== expected.generation
        ) {
          continue;
        }
        const handle = this.store.acquireExisting(group.decodeKey);
        if (handle) {
          cachedHandles.set(job, handle);
        }
      }
      return cachedHandles;
    }

    // Fire every job's request concurrently so the scheduler coalesces them
    // into one in-flight decode; awaiting each in turn would let the slot clear
    // between jobs and re-decode.
    const results = await Promise.all(
      group.jobs.map((job) =>
        this.scheduler
          .acquire({
            decodeKey: group.decodeKey,
            waiter: {
              intent: {
                key: job.sourceFrame.key,
                generation: job.sourceFrame.generation,
              },
              getCurrentIntent: () => ops.getCurrentIntent(job),
            },
            decode: () => ops.decode(group),
          })
          .then((res) => ({ job, res })),
      ),
    );

    const groupHandles = new Map<PlannedClipJob, SharedTextureHandle>();
    let decodedFrame: TFrame | undefined;
    let claimEntry:
      | ReturnType<DecodedFrameClaimArbiter<TFrame>["register"]>
      | undefined;
    try {
      for (const { job, res } of results) {
        decodedFrame = res.frame;
        claimEntry ??= this.claimArbiter.register(
          group.decodeKey,
          res.frame,
        );
        if (res.status !== "fulfilled") {
          continue;
        }
        // The store wraps the frame once (first acquire) and shares it; every
        // current job in the group gets its own release handle on one texture.
        // Only that first acquire runs `createResource` and can throw before
        // store ownership is established.
        const acquisition = this.store.acquireWithStatus(
          group.decodeKey,
          () => ops.createResource(group.decodeKey, res.frame),
        );
        if (acquisition.created) {
          this.claimArbiter.claim(claimEntry);
        }
        groupHandles.set(job, acquisition.handle);
      }
    } catch (error) {
      for (const handle of groupHandles.values()) {
        handle.release();
      }
      if (claimEntry && decodedFrame !== undefined) {
        this.claimArbiter.disposeIfUnclaimed(
          group.decodeKey,
          claimEntry,
          ops.disposeUnclaimedFrame,
        );
      }
      throw error;
    }

    if (claimEntry && decodedFrame !== undefined) {
      this.claimArbiter.disposeIfUnclaimed(
        group.decodeKey,
        claimEntry,
        ops.disposeUnclaimedFrame,
      );
    }
    return groupHandles;
  }
}
