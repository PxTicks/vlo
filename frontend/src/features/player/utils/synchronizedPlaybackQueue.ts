export interface SynchronizedPlaybackQueueEntry {
  time: number;
  enqueuedAtMs: number;
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

  while (queue.length > 0 && nowMs - queue[0].enqueuedAtMs > maxAgeMs) {
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
  queue.push(entry);
  return pruneSynchronizedPlaybackQueue(queue, entry.enqueuedAtMs, options);
}
