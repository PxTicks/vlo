import { API_BASE_URL } from "../../../config";

const SAM_AUDIO_API = `${API_BASE_URL}/sam-audio`;

export interface SamAudioSourceRegistration {
  sourceId: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
  durationTicks: number;
}

export interface SamAudioPromptPayload {
  text?: string;
  anchors?: Array<Array<["+" | "-", number, number]>>;
  sam2SourceId?: string;
  sam2MaskId?: string;
  predictSpans?: boolean;
  rerankingCandidates?: number;
}

export interface SamAudioJobRequest {
  sourceId: string;
  startTicks: number;
  durationTicks: number;
  prompt: SamAudioPromptPayload;
}

export interface SamAudioJobStatus {
  jobId: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  error: string | null;
  sourceId: string;
  startTicks: number;
  durationTicks: number;
  sampleRate?: number;
  resultDurationTicks?: number;
  predictedSpans?: Array<Array<["+" | "-", number, number]>>;
}

export interface SamAudioStemResponse {
  blob: Blob;
  sampleRate: number;
  durationTicks: number;
  predictedSpans: Array<Array<["+" | "-", number, number]>> | null;
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string };
    if (typeof payload.detail === "string" && payload.detail.trim()) {
      return payload.detail.trim();
    }
  } catch {
    // no-op
  }
  return `SAM-Audio request failed (${response.status})`;
}

function parseNumericHeader(headers: Headers, name: string, fallback: number) {
  const raw = headers.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseSpansHeader(
  headers: Headers,
): Array<Array<["+" | "-", number, number]>> | null {
  const raw = headers.get("X-SamAudio-Spans");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? (parsed as Array<Array<["+" | "-", number, number]>>)
      : null;
  } catch {
    return null;
  }
}

export async function registerSourceAudio(
  file: File,
  sourceHash: string,
): Promise<SamAudioSourceRegistration> {
  const formData = new FormData();
  formData.append("audio", file);
  formData.append("source_hash", sourceHash);

  const response = await fetch(`${SAM_AUDIO_API}/sources`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as SamAudioSourceRegistration;
}

export async function submitSeparationJob(
  request: SamAudioJobRequest,
): Promise<{ jobId: string }> {
  const response = await fetch(`${SAM_AUDIO_API}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as { jobId: string };
}

export async function pollJob(jobId: string): Promise<SamAudioJobStatus> {
  const response = await fetch(`${SAM_AUDIO_API}/jobs/${jobId}`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as SamAudioJobStatus;
}

export async function fetchStem(
  jobId: string,
  stem: "target" | "residual",
): Promise<SamAudioStemResponse> {
  const response = await fetch(`${SAM_AUDIO_API}/jobs/${jobId}/stems/${stem}`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  const blob = await response.blob();
  return {
    blob,
    sampleRate: parseNumericHeader(response.headers, "X-SamAudio-SampleRate", 48_000),
    durationTicks: parseNumericHeader(response.headers, "X-SamAudio-DurationTicks", 0),
    predictedSpans: parseSpansHeader(response.headers),
  };
}

export async function getSamAudioHealth(): Promise<Record<string, unknown>> {
  const response = await fetch(`${SAM_AUDIO_API}/health`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as Record<string, unknown>;
}
