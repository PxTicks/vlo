export const DECODER_WORKER_STARTUP_GRACE_MS = 8000;
export const DECODER_WORKER_RESET_COOLDOWN_MS = 3000;

let lastDecoderWorkerResetAtMs = -Infinity;

export function canResetDecoderWorker(nowMs: number = performance.now()): boolean {
  if (nowMs < lastDecoderWorkerResetAtMs) {
    lastDecoderWorkerResetAtMs = nowMs;
    return true;
  }

  if (
    nowMs - lastDecoderWorkerResetAtMs <
    DECODER_WORKER_RESET_COOLDOWN_MS
  ) {
    return false;
  }

  lastDecoderWorkerResetAtMs = nowMs;
  return true;
}

export function resetDecoderWorkerRecoveryForTests(): void {
  lastDecoderWorkerResetAtMs = -Infinity;
}
