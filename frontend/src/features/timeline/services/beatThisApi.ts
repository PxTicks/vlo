import { API_BASE_URL } from "../../../config";

const BEATS_API = `${API_BASE_URL}/beats`;

export interface BeatThisSourceRegistration {
  sourceId: string;
}

export interface BeatThisDetectRequest {
  sourceId: string;
  ticksPerSecond: number;
  dbn?: boolean;
  model?: string;
}

export interface BeatThisDetectedBeat {
  timeSeconds: number;
  timeTicks: number;
  isDownbeat: boolean;
}

export interface BeatThisDetectResponse {
  sourceId: string;
  modelName: string;
  dbn: boolean;
  beats: BeatThisDetectedBeat[];
  beatCount: number;
  downbeatCount: number;
}

async function parseErrorMessage(resp: Response): Promise<string> {
  try {
    const payload = (await resp.json()) as { detail?: string };
    if (typeof payload.detail === "string" && payload.detail.trim().length > 0) {
      return payload.detail.trim();
    }
  } catch {
    // no-op
  }
  return `Beat This! request failed (${resp.status})`;
}

export async function registerBeatThisSource(
  audio: File,
  sourceHash: string,
): Promise<BeatThisSourceRegistration> {
  const formData = new FormData();
  formData.append("audio", audio);
  formData.append("source_hash", sourceHash);

  const response = await fetch(`${BEATS_API}/sources`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as BeatThisSourceRegistration;
}

export async function detectBeats(
  request: BeatThisDetectRequest,
): Promise<BeatThisDetectResponse> {
  const response = await fetch(`${BEATS_API}/detect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as BeatThisDetectResponse;
}

export async function getBeatThisHealth(): Promise<Record<string, unknown>> {
  const response = await fetch(`${BEATS_API}/health`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as Record<string, unknown>;
}
