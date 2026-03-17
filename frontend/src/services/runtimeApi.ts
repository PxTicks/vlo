import { API_BASE_URL } from "../config";
import type { RuntimeStatus } from "../types/RuntimeStatus";

const APP_API = `${API_BASE_URL}/app`;

function extractErrorMessage(payload: unknown): string | null {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const nestedError = record.error;
  if (
    nestedError &&
    typeof nestedError === "object" &&
    !Array.isArray(nestedError)
  ) {
    const nestedRecord = nestedError as Record<string, unknown>;
    if (typeof nestedRecord.message === "string") {
      const message = nestedRecord.message.trim();
      if (message.length > 0) return message;
    }
  }

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

async function parseErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  const rawText = (await response.text()).trim();
  if (!rawText) {
    return `Runtime status request failed (${response.status})`;
  }

  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(rawText) as unknown;
      return (
        extractErrorMessage(payload) ??
        `Runtime status request failed (${response.status})`
      );
    } catch {
      return rawText;
    }
  }

  return rawText;
}

export async function getRuntimeStatus(
  options: { signal?: AbortSignal } = {},
): Promise<RuntimeStatus> {
  const response = await fetch(`${APP_API}/status`, {
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as RuntimeStatus;
}
