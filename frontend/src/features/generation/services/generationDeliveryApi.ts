import { API_BASE_URL } from "../../../config";
import type { GeneratedCreationMetadata } from "../../../types/Asset";
import type {
  AspectRatioProcessingMetadata,
  GenerationJobOutput,
  WorkflowPostprocessingConfig,
} from "../types";

export interface GenerationDeliveryFileRef {
  filename: string;
  download_url: string;
  mime_type?: string;
  frame_index?: number;
}

export interface GenerationDeliveryManifest {
  delivery_id: string;
  project_id: string;
  prompt_id: string | null;
  client_id?: string | null;
  status: "queued" | "running" | "completed_pending_ack" | "error";
  progress?: number | null;
  current_node?: string | null;
  error?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
  submitted_at?: number | null;
  completed_at?: number | null;
  plan_id?: string | null;
  workflow_name?: string | null;
  workflow_source_id?: string | null;
  generation_metadata: GeneratedCreationMetadata;
  postprocess_config?: WorkflowPostprocessingConfig | null;
  auto_family_request_key?: string | null;
  uses_save_image_websocket_outputs?: boolean;
  workflow_warnings?: Array<Record<string, unknown>>;
  applied_widget_values?: Record<string, string>;
  aspect_ratio_processing?: AspectRatioProcessingMetadata | null;
  outputs: GenerationJobOutput[];
  preview_frames: GenerationDeliveryFileRef[];
  prepared_mask?: GenerationDeliveryFileRef | null;
  delivery_context?: Record<string, unknown>;
  last_delivery_error?: string | null;
}

export interface GenerationDeliveryLeaseStateMessage {
  type: "lease_state";
  data: {
    project_id: string;
    active: boolean;
  };
}

export interface GenerationDeliverySnapshotMessage {
  type: "snapshot";
  data: {
    project_id: string;
    deliveries: GenerationDeliveryManifest[];
  };
}

export interface GenerationDeliveryUpdateMessage {
  type: "delivery_update";
  data: {
    delivery: GenerationDeliveryManifest;
  };
}

export interface GenerationDeliveryRemovedMessage {
  type: "delivery_removed";
  data: {
    delivery_id: string;
    prompt_id?: string | null;
  };
}

export type GenerationDeliveryMessage =
  | GenerationDeliveryLeaseStateMessage
  | GenerationDeliverySnapshotMessage
  | GenerationDeliveryUpdateMessage
  | GenerationDeliveryRemovedMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGenerationDeliveryMessage(
  value: unknown,
): value is GenerationDeliveryMessage {
  if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.data)) {
    return false;
  }

  return (
    value.type === "lease_state" ||
    value.type === "snapshot" ||
    value.type === "delivery_update" ||
    value.type === "delivery_removed"
  );
}

async function throwRequestError(operation: string, response: Response): Promise<never> {
  const message = (await response.text()).trim();
  throw new Error(
    message.length > 0 ? `${operation} failed: ${message}` : `${operation} failed (${response.status})`,
  );
}

export async function getPendingDeliveries(
  projectId: string,
): Promise<GenerationDeliveryManifest[]> {
  const response = await fetch(
    `${API_BASE_URL}/app/generation-delivery/projects/${encodeURIComponent(projectId)}/pending`,
  );
  if (!response.ok) {
    await throwRequestError("Pending deliveries fetch", response);
  }

  const payload = (await response.json()) as {
    deliveries?: GenerationDeliveryManifest[];
  };
  return Array.isArray(payload.deliveries) ? payload.deliveries : [];
}

export async function fetchDeliveryFileAsFile(
  fileRef: GenerationDeliveryFileRef | null | undefined,
): Promise<File | null> {
  if (!fileRef) {
    return null;
  }

  const response = await fetch(fileRef.download_url);
  if (!response.ok) {
    await throwRequestError("Delivery file fetch", response);
  }
  const blob = await response.blob();
  return new File([blob], fileRef.filename, {
    type: fileRef.mime_type ?? blob.type,
  });
}

export function parseGenerationDeliveryMessage(
  raw: string,
): GenerationDeliveryMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isGenerationDeliveryMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
