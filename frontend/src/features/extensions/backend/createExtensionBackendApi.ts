import { z } from "zod";
import { API_BASE_URL } from "../../../config";
import type {
  ExtensionApiScope,
  ExtensionBackendApi,
  ExtensionBackendArtifact,
  ExtensionBackendJobSnapshot,
  ExtensionBackendJobType,
  JsonValue,
} from "../types";
import { jsonValueSchema } from "../persistence/extensionPayload";

const artifactSchema = z.object({
  artifactId: z.string().regex(/^[0-9a-f]{32}$/),
  role: z.enum(["input", "output"]),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const readinessSchema = z.object({
  ready: z.boolean(),
  message: z.string(),
  details: jsonValueSchema.optional(),
});

const jobTypeSchema = z.object({
  id: z.string(),
  label: z.string(),
  timeoutSeconds: z.number().positive(),
  readiness: readinessSchema,
});

const jobDiagnosticSchema = z.object({
  level: z.enum(["debug", "info", "warning", "error"]),
  message: z.string(),
  timestamp: z.number().finite(),
  detail: jsonValueSchema.optional(),
});

const jobSnapshotSchema = z.object({
  jobId: z.string(),
  jobType: z.string(),
  extensionId: z.string(),
  extensionVersion: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  progress: z.number().min(0).max(1),
  message: z.string(),
  cancelRequested: z.boolean(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  result: jsonValueSchema.optional(),
  error: z.string().optional(),
  artifacts: z.array(artifactSchema),
  diagnostics: z.array(jobDiagnosticSchema),
});

const artifactResponseSchema = z.object({ artifact: artifactSchema });
const jobResponseSchema = z.object({ job: jobSnapshotSchema });
const jobsResponseSchema = z.object({ jobs: z.array(jobTypeSchema) });

export class ExtensionBackendApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ExtensionBackendApiError";
    this.status = status;
    this.payload = payload;
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "object" &&
    payload.error !== null &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return fallback;
}

async function readPayload(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

async function requestJson<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new ExtensionBackendApiError(
      errorMessage(payload, `Extension backend request failed (${response.status}).`),
      response.status,
      payload,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ExtensionBackendApiError(
      "The extension backend returned an invalid response.",
      response.status,
      payload,
    );
  }
  return parsed.data;
}

function combineSignals(
  lifecycleSignal: AbortSignal,
  requestSignal?: AbortSignal | null,
): AbortSignal {
  if (!requestSignal || requestSignal === lifecycleSignal) return lifecycleSignal;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([lifecycleSignal, requestSignal]);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (lifecycleSignal.aborted || requestSignal.aborted) abort();
  else {
    lifecycleSignal.addEventListener("abort", abort, { once: true });
    requestSignal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

function assertRelativeRawPath(path: string): string {
  const normalized = path.trim();
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("?") ||
    normalized.includes("#")
  ) {
    throw new Error("Raw backend paths must be non-empty relative path segments.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Raw backend paths cannot contain empty or traversal segments.");
  }
  return segments.map(encodeURIComponent).join("/");
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createExtensionBackendApi(
  scope: ExtensionApiScope,
): ExtensionBackendApi {
  const root = `${API_BASE_URL}/app/extensions/${encodeURIComponent(scope.extension.id)}`;
  const signalFor = (signal?: AbortSignal) =>
    combineSignals(scope.signal, signal);
  const jobUrl = (jobId: string) =>
    `${root}/jobs/${encodeURIComponent(jobId)}`;

  const api: ExtensionBackendApi = {
    call: (path: string, init: RequestInit = {}): Promise<Response> =>
      fetch(`${root}/api/${assertRelativeRawPath(path)}`, {
        ...init,
        signal: signalFor(init.signal ?? undefined),
      }),
    listJobs: async (options = {}): Promise<readonly ExtensionBackendJobType[]> => {
      const response = await requestJson(`${root}/jobs`, jobsResponseSchema, {
        signal: signalFor(options.signal),
      });
      return response.jobs;
    },
    uploadArtifact: async (
      content: Blob,
      options,
    ): Promise<ExtensionBackendArtifact> => {
      const query = new URLSearchParams({
        filename: options.filename,
        contentType:
          options.contentType || content.type || "application/octet-stream",
      });
      const response = await requestJson(
        `${root}/artifacts?${query.toString()}`,
        artifactResponseSchema,
        {
          method: "POST",
          body: content,
          signal: signalFor(options.signal),
        },
      );
      return response.artifact;
    },
    submitJob: async (
      jobType: string,
      input: JsonValue,
      artifactIds: readonly string[] = [],
      options = {},
    ): Promise<ExtensionBackendJobSnapshot> => {
      const response = await requestJson(
        `${root}/jobs/${encodeURIComponent(jobType)}`,
        jobResponseSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input, artifacts: artifactIds }),
          signal: signalFor(options.signal),
        },
      );
      return response.job;
    },
    getJob: async (jobId, options = {}) => {
      const response = await requestJson(jobUrl(jobId), jobResponseSchema, {
        signal: signalFor(options.signal),
      });
      return response.job;
    },
    cancelJob: async (jobId, options = {}) => {
      const response = await requestJson(
        `${jobUrl(jobId)}/cancel`,
        jobResponseSchema,
        { method: "POST", signal: signalFor(options.signal) },
      );
      return response.job;
    },
    waitForJob: async (jobId, options = {}) => {
      const signal = signalFor(options.signal);
      const interval = options.pollIntervalMs ?? 250;
      if (!Number.isFinite(interval) || interval < 10 || interval > 60_000) {
        throw new RangeError("pollIntervalMs must be between 10 and 60000.");
      }
      while (true) {
        const response = await requestJson(jobUrl(jobId), jobResponseSchema, {
          signal,
        });
        options.onProgress?.(response.job);
        if (["succeeded", "failed", "cancelled"].includes(response.job.status)) {
          return response.job;
        }
        await wait(interval, signal);
      }
    },
    getArtifact: async (artifactId, options = {}) => {
      const response = await fetch(
        `${root}/artifacts/${encodeURIComponent(artifactId)}`,
        { signal: signalFor(options.signal) },
      );
      if (!response.ok) {
        const payload = await readPayload(response);
        throw new ExtensionBackendApiError(
          errorMessage(payload, `Artifact request failed (${response.status}).`),
          response.status,
          payload,
        );
      }
      return response.blob();
    },
    getArtifactUrl: (artifactId: string) =>
      `${root}/artifacts/${encodeURIComponent(artifactId)}`,
  };
  return Object.freeze(api);
}
