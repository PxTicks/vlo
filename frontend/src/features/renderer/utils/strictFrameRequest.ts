export interface StrictFramePending<T> {
  resolve: (payload: T) => void;
  reject: (error: Error) => void;
}

export interface StrictFrameRequestOptions<T> {
  timeoutMs?: number;
  createTimeoutError: (timeoutMs: number) => Error;
  /** Store the pending slot so external code (worker messages, dispose) can settle it. */
  registerPending: (pending: StrictFramePending<T>) => void;
  /** Clear the slot — only if it still holds `pending` (avoids clobbering a replacement). */
  unregisterPending: (pending: StrictFramePending<T>) => void;
  /** Post the underlying render message. Called after the pending slot is installed. */
  sendRequest: () => void;
}

/**
 * Issues a strict decoder render request and returns a promise that resolves
 * when the worker reports a frame (via the registered pending slot), rejects
 * on timeout, or rejects when external code invokes `pending.reject(...)`.
 *
 * Shared by TrackRenderEngine (live/export frames) and MaskVideoFramePlayer
 * (mask video frames). Payload type `T` lets each caller carry whatever
 * metadata it needs back from the worker.
 */
export function awaitStrictFrame<T>(
  options: StrictFrameRequestOptions<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let isSettled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const settle = (finalize: () => void) => {
      if (isSettled) return;
      isSettled = true;
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
      options.unregisterPending(pending);
      finalize();
    };

    const pending: StrictFramePending<T> = {
      resolve: (payload) => settle(() => resolve(payload)),
      reject: (error) => settle(() => reject(error)),
    };

    options.registerPending(pending);

    const { timeoutMs, createTimeoutError } = options;
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        pending.reject(createTimeoutError(timeoutMs));
      }, timeoutMs);
    }

    options.sendRequest();
  });
}
