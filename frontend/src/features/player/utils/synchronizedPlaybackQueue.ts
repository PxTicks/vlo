export interface SynchronizedPlaybackQueueEntry {
  time: number;
  enqueuedAtMs: number;
  temporalPreviewQuality?: "exact" | "approximate";
}

export const MAX_SYNCHRONIZED_PLAYBACK_QUEUE = 4;
export const MAX_SYNCHRONIZED_PLAYBACK_REQUEST_AGE_MS = 180;

interface SynchronizedPlaybackQueueOptions {
  maxAgeMs?: number;
  maxQueueSize?: number;
}

export function pruneSynchronizedPlaybackQueue(
  queue: SynchronizedPlaybackQueueEntry[],
  nowMs: number,
  options: SynchronizedPlaybackQueueOptions = {},
): SynchronizedPlaybackQueueEntry[] {
  const maxAgeMs =
    options.maxAgeMs ?? MAX_SYNCHRONIZED_PLAYBACK_REQUEST_AGE_MS;
  const maxQueueSize =
    options.maxQueueSize ?? MAX_SYNCHRONIZED_PLAYBACK_QUEUE;

  while (
    queue.length > 1 &&
    nowMs - queue[0].enqueuedAtMs > maxAgeMs
  ) {
    queue.shift();
  }

  if (queue.length <= maxQueueSize) {
    return queue;
  }

  const overflow = queue.length - maxQueueSize;
  queue.splice(0, overflow);
  return queue;
}

export function enqueueSynchronizedPlaybackQueueEntry(
  queue: SynchronizedPlaybackQueueEntry[],
  entry: SynchronizedPlaybackQueueEntry,
  options: SynchronizedPlaybackQueueOptions = {},
): SynchronizedPlaybackQueueEntry[] {
  const existingIndex = queue.findIndex(
    (candidate) => candidate.time === entry.time,
  );
  if (existingIndex >= 0) {
    queue.splice(existingIndex, 1);
  }
  queue.push(entry);
  return pruneSynchronizedPlaybackQueue(queue, entry.enqueuedAtMs, options);
}
