import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TOAST_DURATION_MS,
  HostNotificationCenter,
} from "../notificationCenter";

describe("HostNotificationCenter", () => {
  let center: HostNotificationCenter;

  beforeEach(() => {
    vi.useFakeTimers();
    center = new HostNotificationCenter(() => 1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-dismisses a toast without any UI mounted", () => {
    center.postToast({ message: "Rendered" });
    expect(center.list()).toHaveLength(1);
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS - 1);
    expect(center.list()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(center.list()).toEqual([]);
  });

  it("keeps a zero-duration toast until it is dismissed", () => {
    const handle = center.postToast({ message: "Extension failed", durationMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(center.list()).toHaveLength(1);
    handle.dispose();
    expect(center.list()).toEqual([]);
  });

  it("tracks a task's progress and settles it into a toast", () => {
    const task = center.startTask({ title: "Scanning", progress: 0 });
    expect(center.list()[0]).toMatchObject({
      kind: "task",
      title: "Scanning",
      progress: 0,
      cancellable: false,
    });

    task.update({ progress: 0.5, message: "Halfway" });
    expect(center.list()[0]).toMatchObject({ progress: 0.5, message: "Halfway" });

    // Omitted fields keep their value; `null` goes back to indeterminate.
    task.update({ progress: null });
    expect(center.list()[0]).toMatchObject({ progress: null, message: "Halfway" });

    task.settle({ message: "Done" });
    expect(center.list()).toEqual([
      expect.objectContaining({ kind: "toast", message: "Done", tone: "success" }),
    ]);
  });

  it("settles silently and ignores a second settle", () => {
    const task = center.startTask({ title: "Scanning" });
    task.settle();
    expect(center.list()).toEqual([]);
    task.settle({ message: "Late" });
    task.update({ progress: 1 });
    expect(center.list()).toEqual([]);
  });

  it("clamps progress and rejects malformed input", () => {
    const task = center.startTask({ title: "Scanning", progress: 4 });
    expect(center.list()[0]?.progress).toBe(1);
    expect(() => task.update({ progress: Number.NaN })).toThrow(/finite/);
    expect(() => center.postToast({ message: "  " })).toThrow(/non-empty/);
    expect(() => center.postToast({ message: "x", durationMs: -1 })).toThrow(
      /zero or a positive/,
    );
    expect(() =>
      center.postToast({
        message: "x",
        tone: "catastrophe" as never,
      }),
    ).toThrow(/tone/);
  });

  it("cancels through the owner's callback and leaves the entry in place", () => {
    const onCancel = vi.fn();
    const task = center.startTask({ title: "Scanning", onCancel });
    expect(center.list()[0]?.cancellable).toBe(true);

    expect(center.cancel(task.id)).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    // Cancelling asks the work to stop; only the work knows when it has.
    expect(center.list()).toHaveLength(1);

    task.settle();
    expect(center.list()).toEqual([]);
    expect(center.cancel(task.id)).toBe(false);
  });

  it("isolates a throwing cancel handler", () => {
    const task = center.startTask({
      title: "Scanning",
      onCancel: () => {
        throw new Error("boom");
      },
    });
    expect(() => center.cancel(task.id)).not.toThrow();
    task.settle();
  });

  it("attributes and clears entries by owner", () => {
    center.postToast({ message: "Mine", ownerId: "example.a", durationMs: 0 });
    center.startTask({ title: "Theirs", ownerId: "example.b" });
    center.postToast({ message: "Host", durationMs: 0 });

    expect(center.listByOwner("example.a")).toHaveLength(1);
    expect(center.list().filter((entry) => entry.source === "host")).toHaveLength(1);

    center.clearOwner("example.b");
    expect(center.listByOwner("example.b")).toEqual([]);
    expect(center.list()).toHaveLength(2);
  });

  it("does not let a cleared task recreate an owner's notification", () => {
    const task = center.startTask({
      title: "Extension work",
      ownerId: "example.a",
    });

    center.clearOwner("example.a");
    task.settle({ message: "Late completion" });

    expect(center.list()).toEqual([]);
  });

  it("sheds toasts rather than running tasks when it overflows", () => {
    const task = center.startTask({ title: "Long job" });
    for (let index = 0; index < 60; index += 1) {
      center.postToast({ message: `toast ${index}`, durationMs: 0 });
    }
    expect(center.list()).toHaveLength(50);
    expect(center.list().some((entry) => entry.id === task.id)).toBe(true);
  });

  it("keeps the hard cap when every retained entry is a running task", () => {
    const tasks = Array.from({ length: 50 }, (_, index) =>
      center.startTask({ title: `task ${index}` }),
    );

    const toast = center.postToast({ message: "new toast" });

    expect(center.list()).toHaveLength(50);
    expect(center.list().every((entry) => entry.kind === "task")).toBe(true);
    expect(center.list().every((entry) => entry.id !== toast.id)).toBe(true);
    for (const task of tasks) task.dispose();
  });

  it("notifies subscribers and moves its revision on every change", () => {
    const listener = vi.fn();
    const unsubscribe = center.subscribe(listener);
    const before = center.getRevision();
    const handle = center.postToast({ message: "x", durationMs: 0 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(center.getRevision()).toBeGreaterThan(before);
    unsubscribe();
    handle.dispose();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
