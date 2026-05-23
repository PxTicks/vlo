import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelDownload,
  subscribeToProgress,
  type DownloadProgressEvent,
  type StartDownloadResponse,
} from "../../services/downloadApi";

export interface ActiveModelDownload {
  jobId: string;
  modelKey: string;
  progress: DownloadProgressEvent | null;
  /** True when the job was started by another panel/workflow and adopted here. */
  external: boolean;
}

interface UseModelDownloadControllerOptions {
  startDownload: (modelKey: string, context?: DownloadContext) => Promise<StartDownloadResponse>;
  onDownloadComplete?: () => void;
  /** How long to keep the completed entry visible before removing it. */
  completionDelayMs?: number;
}

export interface DownloadContext {
  hfToken?: string;
}

type JobOutcome = "complete" | "failed" | "cancelled" | "error";

export function useModelDownloadController({
  startDownload,
  onDownloadComplete,
  completionDelayMs = 1000,
}: UseModelDownloadControllerOptions) {
  const [activeDownloads, setActiveDownloads] = useState<Record<string, ActiveModelDownload>>({});
  const [error, setError] = useState<string | null>(null);
  const [downloadAllRunning, setDownloadAllRunning] = useState(false);

  const subscriptionsRef = useRef<Map<string, () => void>>(new Map());
  const completionTimersRef = useRef<Map<string, number>>(new Map());
  const adoptedJobIdsRef = useRef<Set<string>>(new Set());
  const downloadAllCancelledRef = useRef(false);

  // Mirror activeDownloads into a ref so async callbacks (subscription
  // handlers, the download-all loop) can read fresh state without depending
  // on the value (which would re-create every callback).
  const activeDownloadsRef = useRef(activeDownloads);
  useEffect(() => {
    activeDownloadsRef.current = activeDownloads;
  }, [activeDownloads]);

  const teardownSubscription = useCallback((modelKey: string) => {
    const unsub = subscriptionsRef.current.get(modelKey);
    if (unsub) {
      unsub();
      subscriptionsRef.current.delete(modelKey);
    }
  }, []);

  const clearCompletionTimer = useCallback((modelKey: string) => {
    const timer = completionTimersRef.current.get(modelKey);
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      completionTimersRef.current.delete(modelKey);
    }
  }, []);

  useEffect(() => {
    const subscriptions = subscriptionsRef.current;
    const timers = completionTimersRef.current;
    return () => {
      for (const unsub of subscriptions.values()) {
        unsub();
      }
      subscriptions.clear();
      for (const timer of timers.values()) {
        globalThis.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  /** Wire up an SSE subscription. Returns a promise that resolves when the job ends. */
  const beginTracking = useCallback(
    (modelKey: string, jobId: string, external: boolean): Promise<JobOutcome> => {
      setActiveDownloads((prev) => ({
        ...prev,
        [modelKey]: { jobId, modelKey, progress: null, external },
      }));

      teardownSubscription(modelKey);

      return new Promise<JobOutcome>((resolve) => {
        const removeEntry = () => {
          setActiveDownloads((prev) => {
            if (!prev[modelKey]) return prev;
            const { [modelKey]: _removed, ...rest } = prev;
            return rest;
          });
        };

        const unsub = subscribeToProgress(
          jobId,
          (event) => {
            setActiveDownloads((prev) => {
              const current = prev[modelKey];
              if (!current || current.jobId !== jobId) return prev;
              return { ...prev, [modelKey]: { ...current, progress: event } };
            });

            if (event.status === "complete") {
              teardownSubscription(modelKey);
              const timer = globalThis.setTimeout(() => {
                completionTimersRef.current.delete(modelKey);
                adoptedJobIdsRef.current.delete(jobId);
                removeEntry();
                onDownloadComplete?.();
              }, completionDelayMs);
              completionTimersRef.current.set(modelKey, timer);
              resolve("complete");
            } else if (event.status === "failed" || event.status === "cancelled") {
              teardownSubscription(modelKey);
              adoptedJobIdsRef.current.delete(jobId);
              if (event.status === "failed") {
                setError(event.error ?? "Download failed");
              }
              removeEntry();
              resolve(event.status);
            }
          },
          (downloadError) => {
            teardownSubscription(modelKey);
            adoptedJobIdsRef.current.delete(jobId);
            // Externally-adopted jobs disconnecting (e.g., another tab closed)
            // shouldn't pop a modal; only surface errors for our own jobs.
            if (!external) {
              setError(downloadError.message);
            }
            removeEntry();
            resolve("error");
          },
        );

        subscriptionsRef.current.set(modelKey, unsub);
      });
    },
    [completionDelayMs, onDownloadComplete, teardownSubscription],
  );

  const handleDownload = useCallback(
    async (
      modelKey: string,
      context?: DownloadContext,
    ): Promise<JobOutcome | "start-failed"> => {
      setError(null);
      clearCompletionTimer(modelKey);

      let result: StartDownloadResponse;
      try {
        result = await startDownload(modelKey, context);
      } catch (downloadError) {
        setError(
          downloadError instanceof Error
            ? downloadError.message
            : "Failed to start download",
        );
        return "start-failed";
      }
      return beginTracking(modelKey, result.jobId, false);
    },
    [beginTracking, clearCompletionTimer, startDownload],
  );

  /** Subscribe to an existing job started elsewhere (e.g., another workflow tab). */
  const adoptExternalJob = useCallback(
    (modelKey: string, jobId: string) => {
      if (adoptedJobIdsRef.current.has(jobId)) return;
      // Guard against re-adopting a job we already track for this model.
      // We read the latest map via the ref to avoid stale-closure issues.
      const existing = activeDownloadsRef.current[modelKey];
      if (existing && existing.jobId === jobId) return;
      adoptedJobIdsRef.current.add(jobId);
      void beginTracking(modelKey, jobId, true);
    },
    [beginTracking],
  );

  const handleCancel = useCallback(
    async (modelKey?: string) => {
      const snapshot = activeDownloadsRef.current;
      const keys = modelKey ? [modelKey] : Object.keys(snapshot);
      if (!modelKey) {
        downloadAllCancelledRef.current = true;
      }
      for (const key of keys) {
        const entry = snapshot[key];
        if (!entry) continue;
        try {
          await cancelDownload(entry.jobId);
        } catch {
          // Cancel is best-effort.
        }
      }
    },
    [],
  );

  /** Run downloads serially. Any non-complete outcome (failure, cancel,
   * SSE error, or a per-row cancel via handleCancel(modelKey)) stops the
   * batch — the user almost certainly didn't mean to keep going. */
  const handleDownloadAll = useCallback(
    async (modelKeys: string[], context?: DownloadContext) => {
      downloadAllCancelledRef.current = false;
      setDownloadAllRunning(true);
      try {
        for (const modelKey of modelKeys) {
          if (downloadAllCancelledRef.current) break;
          const outcome = await handleDownload(modelKey, context);
          if (outcome !== "complete") break;
        }
      } finally {
        setDownloadAllRunning(false);
      }
    },
    [handleDownload],
  );

  const dismissError = useCallback(() => setError(null), []);

  return {
    activeDownloads,
    error,
    dismissError,
    downloadAllRunning,
    handleDownload,
    handleCancel,
    handleDownloadAll,
    adoptExternalJob,
  };
}
