import { API_BASE_URL } from "../../../config";
import type { ClipMaskPoint } from "../../../types/TimelineTypes";

const SAM2_API = `${API_BASE_URL}/sam2`;

export interface Sam2SourceRegistration {
  sourceId: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationSec: number;
}

export interface Sam2GenerateMaskRequest {
  sourceId: string;
  points: ClipMaskPoint[];
  ticksPerSecond: number;
  maskId: string;
  visibleSourceStartTicks?: number;
  visibleSourceDurationTicks?: number;
}

export interface Sam2GeneratedMaskVideo {
  blob: Blob;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
}

export interface Sam2GenerateFrameRequest {
  sourceId: string;
  points: ClipMaskPoint[];
  ticksPerSecond: number;
  timeTicks: number;
  maskId: string;
}

export interface Sam2GeneratedMaskFrame {
  blob: Blob;
  width: number;
  height: number;
  frameIndex: number;
  timeTicks: number;
}

export interface Sam2EditorSessionRequest {
  sourceId: string;
  maskId: string;
  ticksPerSecond?: number;
  visibleSourceStartTicks?: number;
  visibleSourceDurationTicks?: number;
}

export interface Sam2EditorSessionResponse {
  sourceId: string;
  maskId: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  frameWindowStartFrame?: number;
  frameWindowEndFrame?: number;
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
  return `SAM2 request failed (${resp.status})`;
}

function parseNumericHeader(
  headers: Headers,
  name: string,
  fallback: number,
): number {
  const raw = headers.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function registerSourceVideo(
  file: File,
  sourceHash: string,
): Promise<Sam2SourceRegistration> {
  const formData = new FormData();
  formData.append("video", file);
  formData.append("source_hash", sourceHash);

  const response = await fetch(`${SAM2_API}/sources`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as Sam2SourceRegistration;
}

export async function initSam2EditorSession(
  request: Sam2EditorSessionRequest,
): Promise<Sam2EditorSessionResponse> {
  const response = await fetch(`${SAM2_API}/editor/session/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as Sam2EditorSessionResponse;
}

export async function clearSam2EditorSession(
  request: Sam2EditorSessionRequest,
): Promise<void> {
  const response = await fetch(`${SAM2_API}/editor/session/clear`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
}

export async function generateMaskVideo(
  request: Sam2GenerateMaskRequest,
): Promise<Sam2GeneratedMaskVideo> {
  const response = await fetch(`${SAM2_API}/masks/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  const blob = await response.blob();
  return {
    blob,
    width: parseNumericHeader(response.headers, "X-Sam2-Width", 0),
    height: parseNumericHeader(response.headers, "X-Sam2-Height", 0),
    fps: parseNumericHeader(response.headers, "X-Sam2-Fps", 0),
    frameCount: parseNumericHeader(response.headers, "X-Sam2-Frame-Count", 0),
  };
}

export async function generateMaskFrame(
  request: Sam2GenerateFrameRequest,
  options?: { signal?: AbortSignal },
): Promise<Sam2GeneratedMaskFrame> {
  const response = await fetch(`${SAM2_API}/masks/frame`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  const blob = await response.blob();
  return {
    blob,
    width: parseNumericHeader(response.headers, "X-Sam2-Width", 0),
    height: parseNumericHeader(response.headers, "X-Sam2-Height", 0),
    frameIndex: parseNumericHeader(response.headers, "X-Sam2-Frame-Index", 0),
    timeTicks: parseNumericHeader(response.headers, "X-Sam2-Time-Ticks", 0),
  };
}

export async function getSam2Health(): Promise<Record<string, unknown>> {
  const response = await fetch(`${SAM2_API}/health`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as Record<string, unknown>;
}
