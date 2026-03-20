import { API_BASE_URL } from "../../../config";
import type {
  AspectRatioProcessingMetadata,
  MaskCropMetadata,
  WorkflowMaskCroppingMode,
} from "../types";
import {
  DEFAULT_WORKFLOW_MASK_CROPPING,
  DEFAULT_WORKFLOW_POSTPROCESSING,
} from "./workflowRules";
import { normalizeWorkflowFilename } from "./workflowFilenames";
import type {
  WorkflowRuleWarning,
  WorkflowRules,
  WorkflowRulesResponse,
} from "./workflowRules";
import { isRecord } from "./parsers";

const COMFY_API = `${API_BASE_URL}/comfy`;

export interface PromptSubmission {
  prompt: Record<string, unknown>;
  client_id: string;
  prompt_id?: string;
}

export interface PromptResponse {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
  workflow_warnings?: WorkflowRuleWarning[];
  applied_widget_values?: Record<string, string>;
  aspect_ratio_processing?: AspectRatioProcessingMetadata;
  mask_crop_metadata?: MaskCropMetadata;
  processed_mask_video?: string; // base64-encoded video bytes
}

function extractNodeErrors(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  const rawNodeErrors = payload.node_errors;
  if (!isRecord(rawNodeErrors)) return null;
  return rawNodeErrors;
}

function extractPrimaryErrorMessage(payload: unknown): string | null {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!isRecord(payload)) return null;

  const nestedError = payload.error;
  if (isRecord(nestedError) && typeof nestedError.message === "string") {
    const message = nestedError.message.trim();
    if (message.length > 0) return message;
  }

  if (typeof payload.message === "string") {
    const message = payload.message.trim();
    if (message.length > 0) return message;
  }

  return null;
}

function summarizeNodeErrors(
  nodeErrors: Record<string, unknown> | null,
): string | null {
  if (!nodeErrors) return null;

  const entries = Object.entries(nodeErrors);
  if (entries.length === 0) return null;

  const [nodeId, nodeData] = entries[0];
  if (!isRecord(nodeData)) return `node ${nodeId}`;

  const errors = nodeData.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const firstError = errors[0];
    if (isRecord(firstError)) {
      const message =
        typeof firstError.message === "string" ? firstError.message.trim() : "";
      const details =
        typeof firstError.details === "string" ? firstError.details.trim() : "";
      const combined = [message, details].filter(Boolean).join(" ").trim();
      if (combined.length > 0) return `node ${nodeId}: ${combined}`;
    }
  }

  const classType =
    typeof nodeData.class_type === "string" ? nodeData.class_type : "";
  return classType ? `node ${nodeId} (${classType})` : `node ${nodeId}`;
}

async function parsePayload(resp: Response): Promise<unknown> {
  const contentType = resp.headers.get("content-type") ?? "";
  const rawText = await resp.text();
  const text = rawText.trim();
  if (!text) return null;

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

async function throwRequestError(
  operation: string,
  resp: Response,
): Promise<never> {
  const payload = await parsePayload(resp);
  throw new Error(formatComfyErrorMessage(operation, resp.status, payload));
}

function formatComfyErrorMessage(
  operation: string,
  status: number,
  payload: unknown,
): string {
  let message = `${operation} failed (${status})`;

  const primary = extractPrimaryErrorMessage(payload);
  if (primary) {
    message += `: ${primary}`;
  }

  const nodeSummary = summarizeNodeErrors(extractNodeErrors(payload));
  if (nodeSummary) {
    message += primary ? ` [${nodeSummary}]` : `: ${nodeSummary}`;
  }

  return message;
}

function hasNodeErrors(nodeErrors: Record<string, unknown> | null): boolean {
  return !!nodeErrors && Object.keys(nodeErrors).length > 0;
}

export class ComfyApiError extends Error {
  readonly status: number;
  readonly payload: unknown;
  readonly nodeErrors: Record<string, unknown> | null;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ComfyApiError";
    this.status = status;
    this.payload = payload;
    this.nodeErrors = extractNodeErrors(payload);
  }
}

export async function submitPrompt(
  submission: PromptSubmission,
): Promise<PromptResponse> {
  const resp = await fetch(`${COMFY_API}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(submission),
  });
  if (!resp.ok) {
    const payload = await parsePayload(resp);
    throw new ComfyApiError(
      formatComfyErrorMessage("Prompt submission", resp.status, payload),
      resp.status,
      payload,
    );
  }

  const data = (await resp.json()) as PromptResponse;
  if (hasNodeErrors(data.node_errors)) {
    const validationStatus = resp.status >= 400 ? resp.status : 400;
    const payload = {
      error: { message: "Prompt validation failed before execution" },
      node_errors: data.node_errors,
    };
    throw new ComfyApiError(
      formatComfyErrorMessage("Prompt submission", validationStatus, payload),
      validationStatus,
      payload,
    );
  }

  return data;
}

export async function interrupt(): Promise<void> {
  const resp = await fetch(`${COMFY_API}/api/interrupt`, { method: "POST" });
  if (!resp.ok) {
    await throwRequestError("Interrupt", resp);
  }
}

export async function getHealth(): Promise<{ status: string }> {
  const resp = await fetch(`${COMFY_API}/health`);
  if (!resp.ok) {
    await throwRequestError("ComfyUI health check", resp);
  }
  return resp.json();
}

export async function getConfig(): Promise<{
  comfyui_url: string;
}> {
  const resp = await fetch(`${COMFY_API}/config`);
  if (!resp.ok) {
    await throwRequestError("ComfyUI config fetch", resp);
  }
  return resp.json();
}

export async function updateConfig(
  comfyuiUrl: string,
): Promise<{ comfyui_url: string }> {
  const resp = await fetch(`${COMFY_API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ comfyui_url: comfyuiUrl }),
  });
  if (!resp.ok) {
    await throwRequestError("ComfyUI config update", resp);
  }
  return resp.json();
}

export function getOutputViewUrl(
  filename: string,
  subfolder = "",
  type = "output",
): string {
  const params = new URLSearchParams({ filename, subfolder, type });
  return `${COMFY_API}/api/view?${params}`;
}

export async function generate(request: {
  workflow: Record<string, unknown> | null;
  graphData?: Record<string, unknown> | null;
  workflowId?: string | null;
  targetAspectRatio: string;
  targetResolution: number;
  textInputs: Record<string, string>;
  imageInputs: Record<string, File>;
  videoInputs: Record<string, File>;
  manualSlotTextInputs?: Record<string, string>;
  manualSlotImageInputs?: Record<string, File>;
  manualSlotVideoInputs?: Record<string, File>;
  manualSlotAudioInputs?: Record<string, File>;
  widgetInputs?: Record<string, string>;
  derivedWidgetInputs?: Record<string, string>;
  widgetModes?: Record<string, "fixed" | "randomize">;
  maskCropDilation?: number;
  maskCropMode?: WorkflowMaskCroppingMode;
  clientId: string;
},
options: { signal?: AbortSignal } = {},
): Promise<PromptResponse> {
  const formData = new FormData();
  formData.append("client_id", request.clientId);

  if (request.workflowId) {
    formData.append("workflow_id", request.workflowId);
  }

  if (request.workflow) {
    formData.append("workflow", JSON.stringify(request.workflow));
  }
  if (request.graphData) {
    formData.append("graph_data", JSON.stringify(request.graphData));
  }
  formData.append("target_aspect_ratio", request.targetAspectRatio);
  formData.append("target_resolution", String(request.targetResolution));

  for (const [nodeId, text] of Object.entries(request.textInputs)) {
    formData.append(`text_${nodeId}`, text);
  }
  for (const [nodeId, file] of Object.entries(request.imageInputs)) {
    formData.append(`image_${nodeId}`, file);
  }
  for (const [nodeId, file] of Object.entries(request.videoInputs)) {
    formData.append(`video_${nodeId}`, file);
  }
  for (const [slotId, text] of Object.entries(
    request.manualSlotTextInputs ?? {},
  )) {
    formData.append(`slot_text_${slotId}`, text);
  }
  for (const [slotId, file] of Object.entries(
    request.manualSlotImageInputs ?? {},
  )) {
    formData.append(`slot_image_${slotId}`, file);
  }
  for (const [slotId, file] of Object.entries(
    request.manualSlotVideoInputs ?? {},
  )) {
    formData.append(`slot_video_${slotId}`, file);
  }
  for (const [slotId, file] of Object.entries(
    request.manualSlotAudioInputs ?? {},
  )) {
    formData.append(`slot_audio_${slotId}`, file);
  }
  for (const [key, value] of Object.entries(request.widgetInputs ?? {})) {
    formData.append(key, value);
  }
  for (const [key, value] of Object.entries(request.derivedWidgetInputs ?? {})) {
    formData.append(key, value);
  }
  for (const [key, value] of Object.entries(request.widgetModes ?? {})) {
    formData.append(key, value);
  }
  if (request.maskCropMode) {
    formData.append("mask_crop_mode", request.maskCropMode);
  }
  if (request.maskCropDilation != null) {
    formData.append("mask_crop_dilation", String(request.maskCropDilation));
  }

  const resp = await fetch(`${COMFY_API}/generate`, {
    method: "POST",
    body: formData,
    signal: options.signal,
  });
  if (!resp.ok) {
    const payload = await parsePayload(resp);
    throw new ComfyApiError(
      formatComfyErrorMessage("Generation", resp.status, payload),
      resp.status,
      payload,
    );
  }

  const data = (await resp.json()) as PromptResponse;
  if (hasNodeErrors(data.node_errors)) {
    const validationStatus = resp.status >= 400 ? resp.status : 400;
    const payload = {
      error: { message: "Prompt validation failed before execution" },
      node_errors: data.node_errors,
    };
    throw new ComfyApiError(
      formatComfyErrorMessage("Generation", validationStatus, payload),
      validationStatus,
      payload,
    );
  }

  return data;
}

export async function getHistory(
  promptId: string,
): Promise<Record<string, unknown>> {
  const resp = await fetch(`${COMFY_API}/history/${promptId}`);
  if (!resp.ok) {
    await throwRequestError("History fetch", resp);
  }
  return (await resp.json()) as Record<string, unknown>;
}

export async function fetchOutputAsFile(
  filename: string,
  subfolder = "",
  type = "output",
): Promise<File> {
  const url = getOutputViewUrl(filename, subfolder, type);
  const resp = await fetch(url);
  if (!resp.ok) {
    await throwRequestError("Output fetch", resp);
  }
  const blob = await resp.blob();
  return new File([blob], filename, { type: blob.type });
}

export async function getObjectInfo(): Promise<Record<string, unknown>> {
  const resp = await fetch(`${COMFY_API}/api/object_info`);
  if (!resp.ok) {
    await throwRequestError("object_info fetch", resp);
  }
  return (await resp.json()) as Record<string, unknown>;
}

export interface SyncObjectInfoResult {
  synced: boolean;
  node_classes: number;
  input_node_map?: Record<
    string,
    Array<{
      input_type: string;
      param: string;
      label?: string;
      description?: string | null;
    }>
  >;
}

export async function syncObjectInfo(): Promise<SyncObjectInfoResult> {
  const resp = await fetch(`${COMFY_API}/object_info/sync`, { method: "POST" });
  if (!resp.ok) {
    await throwRequestError("object_info sync", resp);
  }
  return resp.json();
}

export async function listWorkflows(): Promise<
  Array<{ id: string; name: string }>
> {
  const resp = await fetch(`${COMFY_API}/workflow/list`);
  if (!resp.ok) {
    await throwRequestError("Workflow list fetch", resp);
  }
  return resp.json();
}

export async function getWorkflowContent(
  filename: string,
): Promise<Record<string, unknown>> {
  const normalizedFilename = normalizeWorkflowFilename(filename) ?? filename;
  const resp = await fetch(`${COMFY_API}/workflow/content/${normalizedFilename}`);
  if (!resp.ok) {
    await throwRequestError("Workflow content fetch", resp);
  }
  return resp.json();
}

export async function saveWorkflowContent(
  filename: string,
  workflow: Record<string, unknown>,
  objectInfo?: Record<string, unknown>,
): Promise<void> {
  const normalizedFilename = normalizeWorkflowFilename(filename) ?? filename;
  const resp = await fetch(`${COMFY_API}/workflow/content/${normalizedFilename}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workflow,
      ...(objectInfo ? { object_info: objectInfo } : {}),
    }),
  });
  if (!resp.ok) {
    await throwRequestError("Workflow save", resp);
  }
}

export async function getWorkflowRules(
  filename: string,
): Promise<WorkflowRulesResponse> {
  const normalizedFilename = normalizeWorkflowFilename(filename) ?? filename;
  const resp = await fetch(`${COMFY_API}/workflow/rules/${normalizedFilename}`);
  if (!resp.ok) {
    await throwRequestError("Workflow rules fetch", resp);
  }
  const payload = (await resp.json()) as WorkflowRulesResponse;
  if (!payload.rules) {
    payload.rules = {
      version: 1,
      nodes: {},
      output_injections: {},
      slots: {},
      mask_cropping: { ...DEFAULT_WORKFLOW_MASK_CROPPING },
      postprocessing: { ...DEFAULT_WORKFLOW_POSTPROCESSING },
    } as WorkflowRules;
  }
  if (!payload.rules.mask_cropping) {
    payload.rules.mask_cropping = { ...DEFAULT_WORKFLOW_MASK_CROPPING };
  }
  if (!payload.rules.postprocessing) {
    payload.rules.postprocessing = { ...DEFAULT_WORKFLOW_POSTPROCESSING };
  }
  if (!Array.isArray(payload.warnings)) {
    payload.warnings = [];
  }
  return payload;
}
