import type { GenerationJobOutput } from "../types";
import { API_BASE_URL } from "../../../config";

const COMFY_API = `${API_BASE_URL}/comfy`;

function getOutputViewUrl(
  filename: string,
  subfolder = "",
  type = "output",
): string {
  const params = new URLSearchParams({ filename, subfolder, type });
  return `${COMFY_API}/api/view?${params}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveExplicitViewUrl(item: Record<string, unknown>): string | null {
  const rawUrl =
    typeof item.view_url === "string"
      ? item.view_url
      : typeof item.viewUrl === "string"
        ? item.viewUrl
        : typeof item.url === "string"
          ? item.url
          : null;

  if (!rawUrl) return null;
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  if (rawUrl.startsWith("/")) return `${COMFY_API}${rawUrl}`;
  return `${COMFY_API}/${rawUrl}`;
}

function toGenerationJobOutput(item: unknown): GenerationJobOutput | null {
  if (!isRecord(item) || typeof item.filename !== "string") return null;

  const subfolder = typeof item.subfolder === "string" ? item.subfolder : "";
  const type = typeof item.type === "string" ? item.type : "output";
  const explicitViewUrl = resolveExplicitViewUrl(item);

  return {
    filename: item.filename,
    subfolder,
    type,
    viewUrl: explicitViewUrl ?? getOutputViewUrl(item.filename, subfolder, type),
  };
}

export function parseNodeOutputItems(nodeOutput: unknown): GenerationJobOutput[] {
  if (!isRecord(nodeOutput)) return [];

  const images = Array.isArray(nodeOutput.images) ? nodeOutput.images : [];
  const gifs = Array.isArray(nodeOutput.gifs) ? nodeOutput.gifs : [];
  const videos = Array.isArray(nodeOutput.videos) ? nodeOutput.videos : [];
  const audios = Array.isArray(nodeOutput.audios) ? nodeOutput.audios : [];
  const audio = Array.isArray(nodeOutput.audio) ? nodeOutput.audio : [];

  return [...images, ...gifs, ...videos, ...audios, ...audio]
    .map((item) => toGenerationJobOutput(item))
    .filter((item): item is GenerationJobOutput => item !== null);
}

export function parseHistoryOutputs(
  history: Record<string, unknown>,
  promptId: string,
): { hasPromptEntry: boolean; outputs: GenerationJobOutput[] } {
  const hasPromptEntry = Object.prototype.hasOwnProperty.call(history, promptId);
  const promptHistory = history[promptId];

  if (!isRecord(promptHistory) || !isRecord(promptHistory.outputs)) {
    return { hasPromptEntry, outputs: [] };
  }

  const outputs: GenerationJobOutput[] = [];
  for (const nodeOutput of Object.values(promptHistory.outputs)) {
    outputs.push(...parseNodeOutputItems(nodeOutput));
  }

  return { hasPromptEntry, outputs };
}

function extractQueuePromptId(entry: unknown): string | null {
  if (Array.isArray(entry)) {
    return typeof entry[1] === "string" ? entry[1] : null;
  }

  if (!isRecord(entry)) {
    return null;
  }

  return typeof entry.prompt_id === "string" ? entry.prompt_id : null;
}

export function parseQueuePromptIds(queue: unknown): Set<string> {
  const promptIds = new Set<string>();
  if (!isRecord(queue)) {
    return promptIds;
  }

  for (const key of ["queue_running", "queue_pending"] as const) {
    const entries = queue[key];
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      const promptId = extractQueuePromptId(entry);
      if (promptId) {
        promptIds.add(promptId);
      }
    }
  }

  return promptIds;
}
