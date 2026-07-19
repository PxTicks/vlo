import { API_BASE_URL } from "../../../config";
import type { JsonValue } from "../types";
import { cloneStorageValue } from "./ExtensionProjectStorage";

const EXTENSIONS_API_ROOT = `${API_BASE_URL}/app/extensions`;

function storageUrl(extensionId: string, key?: string): string {
  const base = `${EXTENSIONS_API_ROOT}/${encodeURIComponent(extensionId)}/storage/local`;
  return key === undefined ? base : `${base}/${encodeURIComponent(key)}`;
}

async function requestStorage(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok && response.status !== 404) {
    let detail = `${response.status}`;
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      // Status alone is enough when the body is not JSON.
    }
    throw new Error(`Extension local storage request failed: ${detail}`);
  }
  return response;
}

export async function listLocalStorageKeys(
  extensionId: string,
): Promise<readonly string[]> {
  const response = await requestStorage(storageUrl(extensionId));
  const body = (await response.json()) as { keys?: unknown };
  return Array.isArray(body.keys)
    ? body.keys.filter((key): key is string => typeof key === "string")
    : [];
}

export async function getLocalStorageValue(
  extensionId: string,
  key: string,
): Promise<JsonValue | undefined> {
  const response = await requestStorage(storageUrl(extensionId, key));
  if (response.status === 404) return undefined;
  const body = (await response.json()) as { value: JsonValue };
  return cloneStorageValue(body.value);
}

export async function setLocalStorageValue(
  extensionId: string,
  key: string,
  value: JsonValue,
): Promise<void> {
  const response = await requestStorage(storageUrl(extensionId, key), {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
  if (response.status === 404) {
    throw new Error("Extension local storage endpoint is unavailable.");
  }
}

export async function deleteLocalStorageValue(
  extensionId: string,
  key: string,
): Promise<void> {
  await requestStorage(storageUrl(extensionId, key), { method: "DELETE" });
}
