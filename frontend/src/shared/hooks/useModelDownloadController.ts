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
}

interface UseModelDownloadControllerOptions {
  startDownload: (modelKey: string, context?: DownloadContext) => Promise<StartDownloadResponse>;
  onDownloadComplete?: () => void;
  completionDelayMs?: number;
}

export interface DownloadContext {
  hfToken?: string;
}

export function useModelDownloadController({
  startDownload,
  onDownloadComplete,
  completionDelayMs = 1000,
}: UseModelDownloadControllerOptions) {
  const [activeDownload, setActiveDownload] = useState<ActiveModelDownload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const completionTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      unsubRef.current?.();
      if (completionTimerRef.current !== null) {
        globalThis.clearTimeout(completionTimerRef.current);
      }
    };
  }, []);

  const handleDownload = useCallback(
    async (modelKey: string, context?: DownloadContext) => {
      setError(null);

      if (completionTimerRef.current !== null) {
        globalThis.clearTimeout(completionTimerRef.current);
        completionTimerRef.current = null;
      }

      try {
        const result = await startDownload(modelKey, context);
        setActiveDownload({ jobId: result.jobId, modelKey, progress: null });

        unsubRef.current?.();
        unsubRef.current = subscribeToProgress(
          result.jobId,
          (event) => {
            setActiveDownload((prev) =>
              prev ? { ...prev, progress: event } : prev,
            );

            if (event.status === "complete") {
              unsubRef.current?.();
              unsubRef.current = null;
              completionTimerRef.current = globalThis.setTimeout(() => {
                completionTimerRef.current = null;
                onDownloadComplete?.();
                setActiveDownload(null);
              }, completionDelayMs);
            }

            if (event.status === "failed" || event.status === "cancelled") {
              unsubRef.current?.();
              unsubRef.current = null;
              if (event.status === "failed") {
                setError(event.error ?? "Download failed");
              }
              setActiveDownload(null);
            }
          },
          (downloadError) => {
            setError(downloadError.message);
            setActiveDownload(null);
          },
        );
      } catch (downloadError) {
        setError(
          downloadError instanceof Error
            ? downloadError.message
            : "Failed to start download",
        );
      }
    },
    [completionDelayMs, onDownloadComplete, startDownload],
  );

  const handleCancel = useCallback(async () => {
    if (!activeDownload) return;

    try {
      await cancelDownload(activeDownload.jobId);
    } catch {
      // Cancel is best-effort.
    }
  }, [activeDownload]);

  return {
    activeDownload,
    error,
    handleDownload,
    handleCancel,
  };
}
