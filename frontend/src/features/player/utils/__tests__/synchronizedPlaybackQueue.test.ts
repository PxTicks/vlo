import { describe, expect, it } from "vitest";
import {
  enqueueSynchronizedPlaybackQueueEntry,
  pruneSynchronizedPlaybackQueue,
} from "../synchronizedPlaybackQueue";

describe("synchronizedPlaybackQueue", () => {
  it("keeps FIFO order for queued playback batches", () => {
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

    expect(queue.map((entry) => entry.time)).toEqual([10, 20, 30]);
  });

  it("drops the oldest queued batches when capacity is exceeded", () => {
    const queue: Array<{ time: number; enqueuedAtMs: number }> = [];

    [10, 20, 30, 40, 50].forEach((time) => {
      enqueueSynchronizedPlaybackQueueEntry(queue, {
        time,
        enqueuedAtMs: time,
      });
    });

    expect(queue.map((entry) => entry.time)).toEqual([20, 30, 40, 50]);
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
});
