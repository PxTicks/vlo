export interface PollBackendJobOptions<TSnapshot> {
  readonly load: (signal?: AbortSignal) => Promise<TSnapshot>;
  readonly isTerminal: (snapshot: TSnapshot) => boolean;
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly onProgress?: (snapshot: TSnapshot) => void;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      globalThis.clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function pollBackendJob<TSnapshot>({
  load,
  isTerminal,
  signal,
  pollIntervalMs = 250,
  onProgress,
}: PollBackendJobOptions<TSnapshot>): Promise<TSnapshot> {
  if (
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 10 ||
    pollIntervalMs > 60_000
  ) {
    throw new RangeError("pollIntervalMs must be between 10 and 60000.");
  }
  while (true) {
    if (signal?.aborted) throw abortError();
    const snapshot = await load(signal);
    onProgress?.(snapshot);
    if (isTerminal(snapshot)) return snapshot;
    await wait(pollIntervalMs, signal);
  }
}

export function combineAbortSignals(
  lifecycleSignal: AbortSignal,
  requestSignal?: AbortSignal | null,
): AbortSignal {
  if (!requestSignal || requestSignal === lifecycleSignal) return lifecycleSignal;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([lifecycleSignal, requestSignal]);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (lifecycleSignal.aborted || requestSignal.aborted) abort();
  else {
    lifecycleSignal.addEventListener("abort", abort, { once: true });
    requestSignal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}
