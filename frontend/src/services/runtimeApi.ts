import { API_BASE_URL } from "../config";
import type {
  ComfyuiInstallVerification,
  RuntimeCapabilitiesPayload,
  RuntimeCapabilityPayload,
  RuntimeSettingsPatch,
  RuntimeSettingsPayload,
  RuntimeStatus,
} from "../types/RuntimeStatus";

const APP_API = `${API_BASE_URL}/app`;

export type ComfyuiInstallPhase =
  | "idle"
  | "cloning"
  | "creating_environment"
  | "installing_requirements"
  | "complete"
  | "failed";

export interface ComfyuiInstallStatus {
  phase: ComfyuiInstallPhase;
  running: boolean;
  targetPath: string | null;
  message: string | null;
  error: string | null;
}

export interface ComfyuiLaunchResult {
  started: boolean;
  alreadyRunning: boolean;
  requiresPythonChoice?: boolean;
  message?: string;
  pid?: number;
  logPath?: string;
}

interface DirectoryPickerResult {
  cancelled: boolean;
  path: string | null;
  verification: ComfyuiInstallVerification | null;
}

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

export interface RuntimeCapabilityRequestOptions {
  signal?: AbortSignal;
  /**
   * Drop cached probe results and re-run the checks. A cold or refreshed
   * request runs out-of-process import probes and can take many seconds, so
   * callers should surface a checking state rather than block on it.
   */
  refresh?: boolean;
}

const CAPABILITIES_PATH = `${APP_API}/runtime-capabilities`;

function capabilityUrl(path: string, refresh: boolean | undefined): string {
  return refresh ? `${path}?refresh=true` : path;
}

export async function getRuntimeCapabilities(
  options: RuntimeCapabilityRequestOptions = {},
): Promise<RuntimeCapabilitiesPayload> {
  const response = await fetch(
    capabilityUrl(CAPABILITIES_PATH, options.refresh),
    { signal: options.signal },
  );
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as RuntimeCapabilitiesPayload;
}

export async function getRuntimeCapability(
  capabilityId: string,
  options: RuntimeCapabilityRequestOptions = {},
): Promise<RuntimeCapabilityPayload> {
  const response = await fetch(
    capabilityUrl(
      `${CAPABILITIES_PATH}/${encodeURIComponent(capabilityId)}`,
      options.refresh,
    ),
    { signal: options.signal },
  );
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as RuntimeCapabilityPayload;
}

export async function getRuntimeSettings(
  options: { signal?: AbortSignal } = {},
): Promise<RuntimeSettingsPayload> {
  const response = await fetch(`${APP_API}/settings`, {
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as RuntimeSettingsPayload;
}

export async function updateRuntimeSettings(
  patch: RuntimeSettingsPatch,
): Promise<RuntimeSettingsPayload> {
  const response = await fetch(`${APP_API}/settings`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as RuntimeSettingsPayload;
}

async function postRuntimeAction<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${APP_API}${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as T;
}

export function pickComfyuiDirectory(
  purpose: "existing" | "install",
): Promise<DirectoryPickerResult> {
  return postRuntimeAction("/comfyui/pick-directory", { purpose });
}

export function verifyComfyuiInstall(
  path: string,
): Promise<ComfyuiInstallVerification> {
  return postRuntimeAction("/comfyui/verify-install", { path });
}

export function installComfyui(
  parentPath: string,
): Promise<ComfyuiInstallStatus> {
  return postRuntimeAction("/comfyui/install", { parentPath });
}

export function prepareComfyuiEnvironment(): Promise<ComfyuiInstallStatus> {
  return postRuntimeAction("/comfyui/environment");
}

export async function getComfyuiInstallStatus(): Promise<ComfyuiInstallStatus> {
  const response = await fetch(`${APP_API}/comfyui/install`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as ComfyuiInstallStatus;
}

export function launchComfyui(
  options: {
    pythonPath?: string;
    useSystemPython?: boolean;
  } = {},
): Promise<ComfyuiLaunchResult> {
  return postRuntimeAction("/comfyui/launch", options);
}
