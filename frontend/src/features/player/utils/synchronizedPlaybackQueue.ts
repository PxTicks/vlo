export interface SynchronizedPlaybackQueueEntry {
  time: number;
  enqueuedAtMs: number;
  temporalPreviewQuality?: "exact" | "approximate";
}

// Playback: the clock runs in real time and rendering is serialized, so a
// backlog would present stale frames rather than drop them. Coalesce to newest.
export const MAX_SYNCHRONIZED_PLAYBACK_QUEUE = 1;

// Scrub requests do not cancel in-flight work; age and population bounds keep
// the pending backlog responsive instead.
export const MAX_SYNCHRONIZED_SCRUB_QUEUE = 4;
export const MAX_SYNCHRONIZED_PLAYBACK_REQUEST_AGE_MS = 180;
export const SYNCHRONIZED_SCRUB_SETTLE_DELAY_MS = 180;

export function maxQueueSizeForMode(isPlaying: boolean): number {
  return isPlaying
    ? MAX_SYNCHRONIZED_PLAYBACK_QUEUE
    : MAX_SYNCHRONIZED_SCRUB_QUEUE;
}

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
