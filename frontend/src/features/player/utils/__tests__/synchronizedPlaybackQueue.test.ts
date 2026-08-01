import { describe, expect, it } from "vitest";
import {
  enqueueSynchronizedPlaybackQueueEntry,
  MAX_SYNCHRONIZED_PLAYBACK_REQUEST_AGE_MS,
  maxQueueSizeForMode,
  pruneSynchronizedPlaybackQueue,
} from "../synchronizedPlaybackQueue";

describe("synchronizedPlaybackQueue", () => {
  it("keeps a scrub backlog bounded by population, dropping oldest first", () => {
    const queue: Array<{ time: number; enqueuedAtMs: number }> = [];
    const maxQueueSize = maxQueueSizeForMode(false);

    for (let index = 0; index < maxQueueSize + 3; index += 1) {
      enqueueSynchronizedPlaybackQueueEntry(
        queue,
        { time: index, enqueuedAtMs: index },
        { maxQueueSize },
      );
    }

    expect(queue).toHaveLength(maxQueueSize);
    expect(queue.at(-1)?.time).toBe(maxQueueSize + 2);
  });

  it("bounds how stale the request a scrub commits to can be", () => {
    const maxQueueSize = maxQueueSizeForMode(false);
    const nowMs = 1_000;
    const queue = [
      { time: 10, enqueuedAtMs: nowMs - 500 },
      { time: 20, enqueuedAtMs: nowMs - 300 },
      { time: 30, enqueuedAtMs: nowMs - 40 },
      { time: 40, enqueuedAtMs: nowMs - 10 },
    ];

    pruneSynchronizedPlaybackQueue(queue, nowMs, { maxQueueSize });

    // The front is what the consumer commits to, so its age is the queue wait.
    const frontAgeMs = nowMs - (queue[0]?.enqueuedAtMs ?? nowMs);
    expect(frontAgeMs).toBeLessThanOrEqual(
      MAX_SYNCHRONIZED_PLAYBACK_REQUEST_AGE_MS,
    );
    expect(queue.map((entry) => entry.time)).toEqual([30, 40]);
  });

  it("coalesces playback requests to the newest pending tick", () => {
    const queue: Array<{ time: number; enqueuedAtMs: number }> = [];

    enqueueSynchronizedPlaybackQueueEntry(queue, {
      time: 10,
      enqueuedAtMs: 10,
    });
    enqueueSynchronizedPlaybackQueueEntry(queue, {
      time: 20,
      enqueuedAtMs: 20,
    });
    enqueueSynchronizedPlaybackQueueEntry(queue, {
      time: 30,
      enqueuedAtMs: 30,
    });

    expect(queue.map((entry) => entry.time)).toEqual([30]);
    expect(maxQueueSizeForMode(true)).toBe(1);
  });

  it("replaces an older queued request for the same tick before pruning", () => {
    const queue = [
      { time: 10, enqueuedAtMs: 10 },
      { time: 20, enqueuedAtMs: 20 },
    ];

    enqueueSynchronizedPlaybackQueueEntry(
      queue,
      {
        time: 10,
        enqueuedAtMs: 30,
      },
      { maxQueueSize: 4 },
    );

    expect(queue).toEqual([
      { time: 20, enqueuedAtMs: 20 },
      { time: 10, enqueuedAtMs: 30 },
    ]);
  });

  it("prunes stale queued batches before they are processed", () => {
    const queue = [
      { time: 10, enqueuedAtMs: 10 },
      { time: 20, enqueuedAtMs: 40 },
      { time: 30, enqueuedAtMs: 120 },
    ];

    pruneSynchronizedPlaybackQueue(queue, 221);

    expect(queue.map((entry) => entry.time)).toEqual([30]);
  });

  it("preserves the newest batch when every queued batch is stale", () => {
    const queue = [
      { time: 10, enqueuedAtMs: 10 },
      { time: 20, enqueuedAtMs: 40 },
      { time: 30, enqueuedAtMs: 120 },
    ];

    pruneSynchronizedPlaybackQueue(queue, 1_000);

    expect(queue.map((entry) => entry.time)).toEqual([30]);
  });
});
