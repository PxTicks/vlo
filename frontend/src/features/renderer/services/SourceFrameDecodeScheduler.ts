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
  | { status: "stale"; frame: TFrame };

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
 * decoded frame. It hands the *same* `frame` value to every waiter — fulfilled
 * or stale — and lets the caller own its lifetime. A stale waiter must not
 * *use* the frame, but it still receives it so the caller can dispose it when a
 * decode group ends up with no current consumer (otherwise that frame's bitmap
 * would leak). The frame is shared, so exactly one owner should free it.
 *
 * Fan-out is by shared reference: every joined waiter receives the *same*
 * `frame`. `TFrame` may therefore be a raw decoded frame (e.g. an `ImageBitmap`)
 * — it need not be a ref-counted handle itself — but the caller MUST guarantee
 * that exactly one owner ever takes/frees that shared frame, and MUST NOT run
 * overlapping consumers that could race to free it. `RenderFramePlanner`
 * `.acquireFrameTextures` is that coordinator: it wraps the frame into the
 * shared texture store once, or disposes it once when no job claims it, under a
 * no-overlap boundary. Without such coordination, fanning one bitmap out to N
 * consumers would invite a double-close / use-after-free.
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
      // Still hand back the frame: the scheduler never owns frame lifetime, so
      // the caller needs it to clean up (e.g. close the bitmap) when a decode
      // group ends up with no current consumer. The caller must not *use* a
      // stale frame, only dispose it if nothing else claimed it.
      return { status: "stale", frame };
    }
    return { status: "fulfilled", frame };
  }
}
