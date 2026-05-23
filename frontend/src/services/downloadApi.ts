import { API_BASE_URL } from "../config";

const DOWNLOADS_API = `${API_BASE_URL}/downloads`;

function extractErrorMessage(payload: unknown): string | null {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;

  if (typeof record.detail === "string") {
    const message = record.detail.trim();
    if (message.length > 0) return message;
  }

  if (typeof record.message === "string") {
    const message = record.message.trim();
    if (message.length > 0) return message;
  }

  return null;
}

async function parseJsonResponse<T>(
  response: Response,
  fallbackMessage: string,
): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  const rawText = (await response.text()).trim();
  const isJson = contentType.includes("application/json");

  if (!response.ok) {
    if (isJson && rawText) {
      try {
        const payload = JSON.parse(rawText) as unknown;
        const message = extractErrorMessage(payload);
        if (message) {
          throw new Error(message);
        }
      } catch (error) {
        if (error instanceof Error && error.message) {
          throw error;
        }
      }
    }
    throw new Error(`${fallbackMessage} (${response.status})`);
  }

  if (!isJson || !rawText) {
    throw new Error(fallbackMessage);
  }

  try {
    return JSON.parse(rawText) as T;
  } catch {
    throw new Error(fallbackMessage);
  }
}

export interface DownloadableModel {
  key: string;
  label: string;
  description: string;
  installed: boolean;
  directory?: string;
  filename?: string;
  gated?: boolean;
  gatedRepoUrl?: string | null;
  /** Set when the model's destination is already being downloaded by another job. */
  activeJobId?: string | null;
}

export interface AvailableModelsResponse {
  sam2: DownloadableModel[];
  comfyui?: {
    modelDownloadsEnabled: boolean;
    workflowModels: DownloadableModel[];
  };
}

export interface StartDownloadResponse {
  jobId: string;
  label: string;
  status: string;
}

export interface StartBatchJob {
  modelKey: string;
  jobId: string;
  label: string;
  status: string;
}

export interface StartBatchError {
  modelKey: string;
  message: string;
}

export interface StartBatchResponse {
  jobs: StartBatchJob[];
  errors: StartBatchError[];
}

export interface DownloadProgressEvent {
  jobId: string;
  label: string;
  status: "queued" | "downloading" | "complete" | "failed" | "cancelled";
  progress: {
    currentFileIndex: number;
    totalFiles: number;
    currentFileBytes: number;
    currentFileTotal: number | null;
    overallBytes: number;
    overallBytesTotal: number | null;
  };
  /** 0 = front of queue (about to start), N = N jobs ahead. Meaningful only
   * while `status === "queued"`. */
  queuePosition?: number;
  error: string | null;
}

export async function getAvailableModels(options: {
  workflowId?: string;
} = {}): Promise<AvailableModelsResponse> {
  const params = new URLSearchParams();
  if (options.workflowId) {
    params.set("workflowId", options.workflowId);
  }

  const url =
    params.size > 0
      ? `${DOWNLOADS_API}/models?${params.toString()}`
      : `${DOWNLOADS_API}/models`;
  const response = await fetch(url);
  return parseJsonResponse<AvailableModelsResponse>(
    response,
    options.workflowId
      ? "Unable to load model download options"
      : "Unable to load SAM2 model list",
  );
}

export async function startModelDownload(
  modelType: string,
  modelKey: string,
  options: {
    workflowId?: string;
    hfToken?: string;
  } = {},
): Promise<StartDownloadResponse> {
  const body: Record<string, unknown> = {
    modelType,
    modelKey,
    workflowId: options.workflowId,
  };
  if (options.hfToken) {
    body.hfToken = options.hfToken;
  }

  const response = await fetch(`${DOWNLOADS_API}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJsonResponse<StartDownloadResponse>(
    response,
    "Unable to start model download",
  );
}

export async function startModelDownloadBatch(
  modelType: string,
  modelKeys: string[],
  options: {
    workflowId?: string;
    hfToken?: string;
  } = {},
): Promise<StartBatchResponse> {
  const body: Record<string, unknown> = {
    modelType,
    modelKeys,
    workflowId: options.workflowId,
  };
  if (options.hfToken) {
    body.hfToken = options.hfToken;
  }

  const response = await fetch(`${DOWNLOADS_API}/start-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJsonResponse<StartBatchResponse>(
    response,
    "Unable to start model downloads",
  );
}

export async function cancelDownload(jobId: string): Promise<void> {
  const response = await fetch(`${DOWNLOADS_API}/${jobId}/cancel`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to cancel download (${response.status})`);
  }
}

export function subscribeToProgress(
  jobId: string,
  onEvent: (event: DownloadProgressEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  const url = `${DOWNLOADS_API}/${jobId}/progress`;
  const eventSource = new EventSource(url);

  function handleMessage(e: MessageEvent) {
    try {
      const data = JSON.parse(e.data as string) as DownloadProgressEvent;
      onEvent(data);
    } catch {
      // ignore parse errors
    }
  }

  eventSource.addEventListener("queued", handleMessage);
  eventSource.addEventListener("downloading", handleMessage);
  eventSource.addEventListener("complete", handleMessage);
  eventSource.addEventListener("failed", handleMessage);
  eventSource.addEventListener("cancelled", handleMessage);

  eventSource.onerror = () => {
    if (eventSource.readyState === EventSource.CLOSED) {
      return;
    }
    onError?.(new Error("Download progress connection lost"));
    eventSource.close();
  };

  return () => {
    eventSource.close();
  };
}
