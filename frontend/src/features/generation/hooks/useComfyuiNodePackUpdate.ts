import { useCallback, useEffect, useRef, useState } from "react";
import {
  getComfyuiInstallStatus,
  updateComfyuiVloNodePack,
  type ComfyuiInstallStatus,
} from "../../../services/runtimeApi";

const POLL_INTERVAL_MS = 1500;

export interface ComfyuiNodePackUpdate {
  /** The running or finished update; null before one is started. */
  status: ComfyuiInstallStatus | null;
  /** Why the update could not start, or why it failed. */
  error: string | null;
  isRunning: boolean;
  start: () => void;
  /** Forget a finished or failed update once its outcome has been read. */
  dismiss: () => void;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Starts the backend's ComfyUI-vlo update and follows it through the install
 * status it shares with ComfyUI installs. `onFinished` runs once the job ends,
 * so the caller can re-read the version report.
 */
export function useComfyuiNodePackUpdate(
  onFinished: () => void,
): ComfyuiNodePackUpdate {
  const [status, setStatus] = useState<ComfyuiInstallStatus | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  });

  const isPolling = status?.running === true;

  useEffect(() => {
    if (!isPolling) return;
    let active = true;
    let pollInFlight = false;
    const interval = window.setInterval(() => {
      if (pollInFlight) return;
      pollInFlight = true;
      void getComfyuiInstallStatus()
        .then((next) => {
          if (!active) return;
          setStatus(next);
          if (!next.running) onFinishedRef.current();
        })
        .catch((err: unknown) => {
          if (!active) return;
          setStatus(null);
          setRequestError(
            errorMessage(err, "Lost track of the ComfyUI-vlo update"),
          );
        })
        .finally(() => {
          pollInFlight = false;
        });
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [isPolling]);

  const start = useCallback(() => {
    setRequestError(null);
    setIsStarting(true);
    void updateComfyuiVloNodePack()
      .then(setStatus)
      .catch((err: unknown) => {
        setRequestError(errorMessage(err, "Failed to update ComfyUI-vlo"));
      })
      .finally(() => {
        setIsStarting(false);
      });
  }, []);

  const dismiss = useCallback(() => {
    setStatus(null);
    setRequestError(null);
  }, []);

  return {
    status,
    error:
      requestError ?? (status?.phase === "failed" ? status.error : null),
    isRunning: isStarting || isPolling,
    start,
    dismiss,
  };
}
