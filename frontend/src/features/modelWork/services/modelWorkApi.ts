import { API_BASE_URL } from "../../../config";

/**
 * The public lifecycle a user sees. Independent of `occupancy` — a job can be
 * cancelled while its worker thread is still resident on the GPU.
 */
export type ModelWorkJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** The physical truth. `stopping` means "cancelled, still finishing". */
export type ModelWorkOccupancy = "waiting" | "occupied" | "stopping" | "released";

export type ModelWorkSource =
  | "beats"
  | "sam2"
  | "sam-audio"
  | "comfyui-vlo"
  | "comfyui-iframe"
  | "extension";

export interface ModelWorkEntry {
  readonly entryId: string;
  readonly resource: string | null;
  readonly tenant: string | null;
  readonly source: ModelWorkSource;
  readonly owner: string;
  readonly label: string;
  readonly jobStatus: ModelWorkJobStatus;
  readonly occupancy: ModelWorkOccupancy;
  readonly progress: number | null;
  readonly message: string | null;
  readonly submittedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly parentOccupancyId: string | null;
  readonly cancelEndpoint: string | null;
  readonly promptId: string | null;
  readonly suspectedStale: boolean;
}

export interface ModelWorkResourceView {
  readonly resource: string;
  readonly width: number;
  readonly tenant: string | null;
  readonly occupancyId: string | null;
  readonly holderCount: number;
}

export interface ModelWorkSnapshot {
  readonly revision: number;
  readonly ready: boolean;
  readonly entries: readonly ModelWorkEntry[];
  readonly resources: readonly ModelWorkResourceView[];
}

export interface ModelWorkEvent {
  readonly revision: number;
  readonly kind: "added" | "updated" | "removed";
  readonly entry: ModelWorkEntry;
  readonly resources: readonly ModelWorkResourceView[];
}

export type ModelWorkMessage =
  | { readonly type: "snapshot"; readonly data: ModelWorkSnapshot }
  | { readonly type: "event"; readonly data: ModelWorkEvent };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseModelWorkMessage(raw: string): ModelWorkMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.data)) {
    return null;
  }
  if (parsed.type === "snapshot" && typeof parsed.data.revision === "number") {
    return { type: "snapshot", data: parsed.data as unknown as ModelWorkSnapshot };
  }
  if (parsed.type === "event" && typeof parsed.data.revision === "number") {
    return { type: "event", data: parsed.data as unknown as ModelWorkEvent };
  }
  return null;
}

export async function fetchModelWorkSnapshot(
  signal?: AbortSignal,
): Promise<ModelWorkSnapshot> {
  const response = await fetch(`${API_BASE_URL}/app/model-work`, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load model work (${response.status})`);
  }
  return (await response.json()) as ModelWorkSnapshot;
}

/**
 * Force-release an occupancy vlo can no longer confirm with ComfyUI. Only ever
 * user-initiated: releasing while the work is genuinely running puts two
 * tenants back on one card.
 */
export async function releaseModelWorkEntry(entryId: string): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL}/app/model-work/${encodeURIComponent(entryId)}/unsafe-release`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error(`Failed to release the entry (${response.status})`);
  }
}
