import {
  isSourceFrameIntentCurrent,
  type SourceFrameSyncIntent,
} from "../utils/sourceFrameSync";

/**
 * Per-waiter staleness context. A decode is coalesced across waiters by
 * `decodeKey`, but each waiter still carries its own clip-scoped intent: when
 * the shared decode settles, a waiter only receives the frame while its intent
 * is still current. This preserves the existing "same intent wins" rule
 * (stale async completions are rejected by intent, not by "newest frame wins").
 */
export interface DecodeWaiter {
  /** Clip-scoped intent captured when this waiter issued its request. */
  intent: SourceFrameSyncIntent;
  /**
   * The clip's latest intent at resolution time. The request is honored only
   * while this still matches the captured `intent`. Returning `null` (e.g. the
   * clip is no longer active) marks the waiter stale.
   */
  getCurrentIntent: () => SourceFrameSyncIntent | null;
}

export type DecodeResult<TFrame> =
  | { status: "fulfilled"; frame: TFrame }
  | { status: "stale" };

interface InFlightDecode<TFrame> {
  promise: Promise<TFrame>;
  /** Number of waiters that have joined this in-flight decode. */
  waiterCount: number;
}

/**
 * Coalesces concurrent decode requests that resolve to the same source frame.
 *
 * N clip jobs that share a `decodeKey` (duplicate clips at the same
 * asset/frame/fps/time) trigger the underlying `decode` factory at most once;
 * every joining waiter awaits the single in-flight promise and acquires the
 * resulting frame. Once a decode settles its slot is cleared, so a later tick
 * decodes afresh — the scheduler coalesces *in-flight* work only and does not
 * cache frames. Frame reuse / lifetime across consumers is the shared
 * texture store's responsibility (Phase 2).
 *
 * Ownership: the scheduler never closes, destroys, or otherwise mutates a
 * decoded frame. It hands the *same* `frame` value to every fulfilled waiter
 * and lets the caller own its lifetime. A waiter that resolves `stale` simply
 * does not receive the frame; it must not assume the frame was freed.
 *
 * Because fan-out is by shared reference, `TFrame` MUST be a multi-consumer,
 * reference-counted handle (the Phase 2 shared texture handle), NOT a raw
 * `ImageBitmap`. Today's render paths create per-engine textures and close
 * stale bitmaps; fanning a single `ImageBitmap` out to N engines would invite a
 * double-close / use-after-free. The scheduler is therefore deliberately left
 * unwired until that shared-handle store exists.
 */
export class SourceFrameDecodeScheduler<TFrame> {
  private readonly inFlight = new Map<string, InFlightDecode<TFrame>>();

  /** Number of distinct decodes currently in flight (diagnostics/tests). */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Join (or start) the in-flight decode for `decodeKey`. `decode` is invoked
   * only when no decode for the key is already running; concurrent callers
   * share that single promise.
   */
  async acquire(options: {
    decodeKey: string;
    waiter: DecodeWaiter;
    decode: () => Promise<TFrame>;
  }): Promise<DecodeResult<TFrame>> {
    const { decodeKey, waiter, decode } = options;

    let entry = this.inFlight.get(decodeKey);
    if (!entry) {
      let promise: Promise<TFrame>;
      try {
        promise = decode();
      } catch (error) {
        promise = Promise.reject(error);
      }
      entry = { promise, waiterCount: 0 };
      this.inFlight.set(decodeKey, entry);
      // Clear the slot once settled (success or failure) so the next request at
      // this key decodes fresh and a failed decode can be retried.
      const settled = entry;
      void promise
        .catch(() => undefined)
        .finally(() => {
          if (this.inFlight.get(decodeKey) === settled) {
            this.inFlight.delete(decodeKey);
          }
        });
    }
    entry.waiterCount += 1;

    const frame = await entry.promise;

    if (!isSourceFrameIntentCurrent(waiter.getCurrentIntent(), waiter.intent)) {
      return { status: "stale" };
    }
    return { status: "fulfilled", frame };
  }
}
