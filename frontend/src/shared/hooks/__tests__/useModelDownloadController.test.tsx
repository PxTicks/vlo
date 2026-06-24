import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadProgressEvent } from "../../../services/downloadApi";
import { useModelDownloadController } from "../useModelDownloadController";

const {
  cancelDownloadMock,
  subscribeToProgressMock,
  subscriptions,
} = vi.hoisted(() => ({
  cancelDownloadMock: vi.fn(),
  subscribeToProgressMock: vi.fn(),
  subscriptions: new Map<
    string,
    {
      onEvent: (event: DownloadProgressEvent) => void;
      onError: (error: Error) => void;
      unsubscribe: ReturnType<typeof vi.fn>;
    }
  >(),
}));

vi.mock("../../../services/downloadApi", () => ({
  cancelDownload: cancelDownloadMock,
  subscribeToProgress: subscribeToProgressMock,
}));

function progress(
  jobId: string,
  status: DownloadProgressEvent["status"],
  error: string | null = null,
): DownloadProgressEvent {
  return {
    jobId,
    label: jobId,
    status,
    progress: {
      currentFileIndex: 0,
      totalFiles: 1,
      currentFileBytes: 1,
      currentFileTotal: 2,
      overallBytes: 1,
      overallBytesTotal: 2,
    },
    error,
  };
}

describe("useModelDownloadController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    subscriptions.clear();
    cancelDownloadMock.mockResolvedValue(undefined);
    subscribeToProgressMock.mockImplementation(
      (
        jobId: string,
        onEvent: (event: DownloadProgressEvent) => void,
        onError: (error: Error) => void,
      ) => {
        const unsubscribe = vi.fn();
        subscriptions.set(jobId, { onEvent, onError, unsubscribe });
        return unsubscribe;
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks a local download through progress, completion, and delayed removal", async () => {
    const startDownload = vi.fn().mockResolvedValue({
      jobId: "job-1",
      label: "One",
      status: "queued",
    });
    const onDownloadComplete = vi.fn();
    const onAllDownloadsComplete = vi.fn();
    const { result } = renderHook(() =>
      useModelDownloadController({
        startDownload,
        onDownloadComplete,
        onAllDownloadsComplete,
        completionDelayMs: 25,
      }),
    );

    let outcome: Promise<string>;
    await act(async () => {
      outcome = result.current.handleDownload("model-1", { hfToken: "token" });
      await Promise.resolve();
    });
    expect(startDownload).toHaveBeenCalledWith("model-1", { hfToken: "token" });
    expect(result.current.anyLocalDownloadActive).toBe(true);
    expect(result.current.activeDownloads["model-1"]).toMatchObject({
      jobId: "job-1",
      external: false,
      progress: null,
    });

    act(() => {
      subscriptions.get("job-1")?.onEvent(progress("job-1", "downloading"));
    });
    expect(result.current.activeDownloads["model-1"]?.progress?.status).toBe(
      "downloading",
    );

    act(() => {
      subscriptions.get("job-1")?.onEvent(progress("job-1", "complete"));
    });
    await expect(outcome!).resolves.toBe("complete");
    expect(subscriptions.get("job-1")?.unsubscribe).toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(25);
    });
    expect(result.current.activeDownloads).toEqual({});
    expect(onDownloadComplete).toHaveBeenCalledTimes(1);
    expect(onAllDownloadsComplete).toHaveBeenCalledTimes(1);
  });

  it("reports start failures and allows errors to be dismissed", async () => {
    const startDownload = vi
      .fn()
      .mockRejectedValueOnce(new Error("credential missing"))
      .mockRejectedValueOnce("bad");
    const { result } = renderHook(() =>
      useModelDownloadController({ startDownload }),
    );

    await act(async () => {
      await expect(result.current.handleDownload("one")).resolves.toBe(
        "start-failed",
      );
    });
    expect(result.current.error).toBe("credential missing");
    act(() => result.current.dismissError());
    expect(result.current.error).toBeNull();

    await act(async () => {
      await result.current.handleDownload("two");
    });
    expect(result.current.error).toBe("Failed to start download");
  });

  it("handles failed, cancelled, and disconnected jobs", async () => {
    const startDownload = vi
      .fn()
      .mockResolvedValueOnce({ jobId: "failed", label: "F", status: "queued" })
      .mockResolvedValueOnce({
        jobId: "cancelled",
        label: "C",
        status: "queued",
      })
      .mockResolvedValueOnce({ jobId: "error", label: "E", status: "queued" });
    const { result } = renderHook(() =>
      useModelDownloadController({ startDownload }),
    );

    let failedOutcome: Promise<string>;
    await act(async () => {
      failedOutcome = result.current.handleDownload("failed-model");
      await Promise.resolve();
    });
    act(() => {
      subscriptions
        .get("failed")
        ?.onEvent(progress("failed", "failed", "disk full"));
    });
    await expect(failedOutcome!).resolves.toBe("failed");
    expect(result.current.error).toBe("disk full");
    expect(result.current.activeDownloads).toEqual({});

    let cancelledOutcome: Promise<string>;
    await act(async () => {
      cancelledOutcome = result.current.handleDownload("cancelled-model");
      await Promise.resolve();
    });
    act(() => {
      subscriptions
        .get("cancelled")
        ?.onEvent(progress("cancelled", "cancelled"));
    });
    await expect(cancelledOutcome!).resolves.toBe("cancelled");

    let errorOutcome: Promise<string>;
    await act(async () => {
      errorOutcome = result.current.handleDownload("error-model");
      await Promise.resolve();
    });
    act(() => subscriptions.get("error")?.onError(new Error("connection lost")));
    await expect(errorOutcome!).resolves.toBe("error");
    expect(result.current.error).toBe("connection lost");
  });

  it("adopts external jobs once and suppresses their connection errors", async () => {
    const { result } = renderHook(() =>
      useModelDownloadController({ startDownload: vi.fn() }),
    );

    act(() => {
      result.current.adoptExternalJob("external-model", "external-job");
      result.current.adoptExternalJob("external-model", "external-job");
    });
    expect(subscribeToProgressMock).toHaveBeenCalledTimes(1);
    expect(result.current.activeDownloads["external-model"]?.external).toBe(true);
    expect(result.current.anyLocalDownloadActive).toBe(false);

    act(() => {
      subscriptions
        .get("external-job")
        ?.onError(new Error("other tab disappeared"));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.activeDownloads).toEqual({});
  });

  it("cancels one or all active jobs on a best-effort basis", async () => {
    const startDownload = vi
      .fn()
      .mockResolvedValueOnce({ jobId: "job-a", label: "A", status: "queued" })
      .mockResolvedValueOnce({ jobId: "job-b", label: "B", status: "queued" });
    const { result } = renderHook(() =>
      useModelDownloadController({ startDownload }),
    );
    await act(async () => {
      void result.current.handleDownload("a");
      void result.current.handleDownload("b");
      await Promise.resolve();
    });

    cancelDownloadMock.mockRejectedValueOnce(new Error("already finished"));
    await act(async () => {
      await result.current.handleCancel("a");
      await result.current.handleCancel();
      await result.current.handleCancel("missing");
    });
    expect(cancelDownloadMock).toHaveBeenCalledWith("job-a");
    expect(cancelDownloadMock).toHaveBeenCalledWith("job-b");
  });

  it("queues batch jobs and summarizes one or many rejected entries", async () => {
    const startBatch = vi
      .fn()
      .mockResolvedValueOnce({
        jobs: [{ modelKey: "a", jobId: "job-a", label: "A", status: "queued" }],
        errors: [{ modelKey: "b", message: "gated" }],
      })
      .mockResolvedValueOnce({
        jobs: [],
        errors: [
          { modelKey: "b", message: "gated" },
          { modelKey: "c", message: "missing" },
        ],
      });
    const { result } = renderHook(() =>
      useModelDownloadController({ startDownload: vi.fn(), startBatch }),
    );

    await act(async () => {
      await result.current.handleDownloadAll(["a", "b"], { hfToken: "token" });
    });
    expect(startBatch).toHaveBeenCalledWith(["a", "b"], { hfToken: "token" });
    expect(result.current.activeDownloads.a?.jobId).toBe("job-a");
    expect(result.current.error).toBe("gated");

    await act(async () => {
      await result.current.handleDownloadAll(["b", "c"]);
    });
    expect(result.current.error).toContain("Some downloads couldn't be queued:");
    expect(result.current.error).toContain("b: gated");
    expect(result.current.error).toContain("c: missing");
  });

  it("handles batch failures and ignores an empty batch", async () => {
    const startBatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("server offline"))
      .mockRejectedValueOnce("bad");
    const { result } = renderHook(() =>
      useModelDownloadController({ startDownload: vi.fn(), startBatch }),
    );

    await act(async () => {
      await result.current.handleDownloadAll([]);
    });
    expect(startBatch).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handleDownloadAll(["a"]);
    });
    expect(result.current.error).toBe("server offline");

    await act(async () => {
      await result.current.handleDownloadAll(["b"]);
    });
    expect(result.current.error).toBe("Failed to start downloads");
  });

  it("runs the legacy queue serially and stops after a non-complete outcome", async () => {
    const startDownload = vi
      .fn()
      .mockResolvedValueOnce({ jobId: "job-a", label: "A", status: "queued" })
      .mockResolvedValueOnce({ jobId: "job-b", label: "B", status: "queued" });
    const { result } = renderHook(() =>
      useModelDownloadController({ startDownload, completionDelayMs: 0 }),
    );

    let queue: Promise<void>;
    await act(async () => {
      queue = result.current.handleDownloadAll(["a", "b", "c"]);
      await Promise.resolve();
    });
    expect(subscriptions.has("job-a")).toBe(true);
    act(() => subscriptions.get("job-a")?.onEvent(progress("job-a", "complete")));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(subscriptions.has("job-b")).toBe(true);
    act(() => subscriptions.get("job-b")?.onEvent(progress("job-b", "cancelled")));
    await act(async () => {
      await queue!;
    });

    expect(startDownload).toHaveBeenCalledTimes(2);
    expect(startDownload).not.toHaveBeenCalledWith("c", undefined);
  });

  it("cleans active subscriptions and completion timers on unmount", async () => {
    const startDownload = vi
      .fn()
      .mockResolvedValue({ jobId: "job-1", label: "A", status: "queued" });
    const { result, unmount } = renderHook(() =>
      useModelDownloadController({
        startDownload,
        completionDelayMs: 100,
      }),
    );
    await act(async () => {
      void result.current.handleDownload("a");
      await Promise.resolve();
    });
    act(() => subscriptions.get("job-1")?.onEvent(progress("job-1", "complete")));
    unmount();

    expect(subscriptions.get("job-1")?.unsubscribe).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
