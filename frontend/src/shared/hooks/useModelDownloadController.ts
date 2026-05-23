import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelDownload,
  subscribeToProgress,
  type DownloadProgressEvent,
  type StartBatchResponse,
  type StartDownloadResponse,
} from "../../services/downloadApi";

export interface ActiveModelDownload {
  jobId: string;
  modelKey: string;
  progress: DownloadProgressEvent | null;
  /** True when the job was started by another panel/workflow and adopted here. */
  external: boolean;
}

export interface DownloadContext {
  hfToken?: string;
}

interface UseModelDownloadControllerOptions {
  startDownload: (modelKey: string, context?: DownloadContext) => Promise<StartDownloadResponse>;
  /** If supplied, "Download all" hands the whole list to the server (one
   * request, one queue) instead of starting jobs from the client. */
  startBatch?: (modelKeys: string[], context?: DownloadContext) => Promise<StartBatchResponse>;
  /** Fires after every individual job completes. Cheap callers can use this
   * to refresh the model list silently. */
  onDownloadComplete?: () => void;
  /** Fires once after the in-flight set drains to empty (i.e. the batch is
   * fully done). Heavier-weight callers (refreshing iframe state, retrying
   * workflow load) should hook this instead of onDownloadComplete. */
  onAllDownloadsComplete?: () => void;
  /** How long to keep the completed entry visible before removing it. */
  completionDelayMs?: number;
}

type JobOutcome = "complete" | "failed" | "cancelled" | "error";

export function useModelDownloadController({
  startDownload,
  startBatch,
  onDownloadComplete,
  onAllDownloadsComplete,
  completionDelayMs = 1000,
}: UseModelDownloadControllerOptions) {
  const [activeDownloads, setActiveDownloads] = useState<Record<string, ActiveModelDownload>>({});
  const [error, setError] = useState<string | null>(null);

  const subscriptionsRef = useRef<Map<string, () => void>>(new Map());
  const completionTimersRef = useRef<Map<string, number>>(new Map());
  const adoptedJobIdsRef = useRef<Set<string>>(new Set());

  const activeDownloadsRef = useRef(activeDownloads);
  useEffect(() => {
    activeDownloadsRef.current = activeDownloads;
  }, [activeDownloads]);

  // Latest callbacks (refs so they don't rebuild beginTracking).
  const onDownloadCompleteRef = useRef(onDownloadComplete);
  useEffect(() => {
    onDownloadCompleteRef.current = onDownloadComplete;
  }, [onDownloadComplete]);
  const onAllDownloadsCompleteRef = useRef(onAllDownloadsComplete);
  useEffect(() => {
    onAllDownloadsCompleteRef.current = onAllDownloadsComplete;
  }, [onAllDownloadsComplete]);

  // Edge-trigger onAllDownloadsComplete when activeDownloads drains.
  const wasNonEmptyRef = useRef(false);
  useEffect(() => {
    const isEmpty = Object.keys(activeDownloads).length === 0;
    if (!isEmpty) {
      wasNonEmptyRef.current = true;
      return;
    }
    if (wasNonEmptyRef.current) {
      wasNonEmptyRef.current = false;
      onAllDownloadsCompleteRef.current?.();
    }
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
                onDownloadCompleteRef.current?.();
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
    [completionDelayMs, teardownSubscription],
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

  /** Queue several downloads. With `startBatch` set this is one server
   * request; queue ordering and "one at a time" are enforced server-side,
   * so switching workflows (which unmounts this hook) does not interrupt
   * the batch — re-mounting will re-adopt the in-flight jobs via
   * `adoptExternalJob`. */
  const handleDownloadAll = useCallback(
    async (modelKeys: string[], context?: DownloadContext) => {
      setError(null);
      if (modelKeys.length === 0) return;

      if (startBatch) {
        let result: StartBatchResponse;
        try {
          result = await startBatch(modelKeys, context);
        } catch (batchError) {
          setError(
            batchError instanceof Error
              ? batchError.message
              : "Failed to start downloads",
          );
          return;
        }

        for (const job of result.jobs) {
          clearCompletionTimer(job.modelKey);
          void beginTracking(job.modelKey, job.jobId, false);
        }

        if (result.errors.length > 0) {
          const summary = result.errors
            .map((entry) => `${entry.modelKey}: ${entry.message}`)
            .join("\n");
          setError(
            result.errors.length === 1
              ? result.errors[0].message
              : `Some downloads couldn't be queued:\n${summary}`,
          );
        }
        return;
      }

      // Legacy fallback for callers that haven't wired up startBatch: run
      // them serially. Stops on any non-complete outcome.
      for (const modelKey of modelKeys) {
        const outcome = await handleDownload(modelKey, context);
        if (outcome !== "complete") break;
      }
    },
    [beginTracking, clearCompletionTimer, handleDownload, startBatch],
  );

  const dismissError = useCallback(() => setError(null), []);

  const anyLocalDownloadActive = Object.values(activeDownloads).some(
    (entry) => !entry.external,
  );

  return {
    activeDownloads,
    error,
    dismissError,
    /** True while we have local in-flight downloads. The old
     * `downloadAllRunning` flag was redundant with this. */
    anyLocalDownloadActive,
    handleDownload,
    handleCancel,
    handleDownloadAll,
    adoptExternalJob,
  };
}
