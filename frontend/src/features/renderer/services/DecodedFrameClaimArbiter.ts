interface ClaimEntry<TFrame> {
  frame: TFrame;
  claimed: boolean;
  disposed: boolean;
  disposeScheduled: boolean;
}

/**
 * Coordinates ownership when overlapping graph generations receive the same
 * decoded frame from SourceFrameDecodeScheduler. A frame is wrapped once or
 * disposed once. Disposal is deferred by one microtask so every waiter attached
 * to the shared decode promise can register its claim before the all-stale path
 * frees the frame.
 */
export class DecodedFrameClaimArbiter<TFrame> {
  private readonly byKey = new Map<string, ClaimEntry<TFrame>>();

  register(decodeKey: string, frame: TFrame): ClaimEntry<TFrame> {
    const existing = this.byKey.get(decodeKey);
    if (existing?.frame === frame && !existing.disposed) {
      return existing;
    }
    const entry: ClaimEntry<TFrame> = {
      frame,
      claimed: false,
      disposed: false,
      disposeScheduled: false,
    };
    this.byKey.set(decodeKey, entry);
    return entry;
  }

  claim(entry: ClaimEntry<TFrame>): void {
    if (!entry.disposed) {
      entry.claimed = true;
    }
  }

  disposeIfUnclaimed(
    decodeKey: string,
    entry: ClaimEntry<TFrame>,
    dispose: (frame: TFrame) => void,
  ): void {
    if (entry.claimed || entry.disposed || entry.disposeScheduled) {
      return;
    }
    entry.disposeScheduled = true;
    queueMicrotask(() => {
      entry.disposeScheduled = false;
      if (entry.claimed || entry.disposed) {
        return;
      }
      entry.disposed = true;
      if (this.byKey.get(decodeKey) === entry) {
        this.byKey.delete(decodeKey);
      }
      dispose(entry.frame);
    });
  }

  forget(decodeKey: string, entry: ClaimEntry<TFrame>): void {
    if (this.byKey.get(decodeKey) === entry) {
      this.byKey.delete(decodeKey);
    }
  }
}
