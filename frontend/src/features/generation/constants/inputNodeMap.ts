import type { WorkflowInput } from "../types";

export interface InputNodeMapEntry {
  inputType: WorkflowInput["inputType"];
  param: string;
  label?: string;
  description?: string | null;
}

export type DynamicInputNodeMapEntry = {
  input_type: string;
  param: string;
  label?: string;
  description?: string | null;
};

export type InputNodeMap = Record<string, InputNodeMapEntry[]>;

/**
 * Static fallback map for node types that cannot be auto-detected from
 * object_info metadata (e.g. VHS_LoadVideo lacks a ``video_upload`` flag).
 *
 * At runtime this is merged with the dynamic map built from object_info by
 * the backend's ``/object_info/sync`` endpoint.
 */
export const INPUT_NODE_MAP: InputNodeMap = {
  LoadImage: [{ inputType: "image", param: "image", label: "Image" }],
  CLIPTextEncode: [{ inputType: "text", param: "text", label: "Prompt" }],
  LoadVideo: [{ inputType: "video", param: "file", label: "Video" }],
  VHS_LoadVideo: [{ inputType: "video", param: "video", label: "Video" }],
};

/**
 * Merge a backend-provided dynamic input node map with the static fallback.
 * Static entries take precedence for backwards compatibility.
 */
export function mergeInputNodeMap(
  dynamic: Record<string, DynamicInputNodeMapEntry[]> | null | undefined,
): InputNodeMap {
  if (!dynamic) return INPUT_NODE_MAP;

  const merged: InputNodeMap = {};
  for (const [classType, entries] of Object.entries(dynamic)) {
    const normalizedEntries: InputNodeMapEntry[] = [];
    for (const entry of entries) {
      const inputType = entry.input_type as WorkflowInput["inputType"];
      if (
        inputType === "image" ||
        inputType === "video" ||
        inputType === "text"
      ) {
        normalizedEntries.push({
          inputType,
          param: entry.param,
          label: entry.label,
          description: entry.description ?? null,
        });
      }
    }
    if (normalizedEntries.length > 0) {
      merged[classType] = normalizedEntries;
    }
  }

  const next: InputNodeMap = { ...merged };
  for (const [classType, staticEntries] of Object.entries(INPUT_NODE_MAP)) {
    const dynamicEntries = next[classType] ?? [];
    const byParam = new Map(
      dynamicEntries.map((entry) => [entry.param, entry] as const),
    );
    for (const entry of staticEntries) {
      byParam.set(entry.param, entry);
    }
    next[classType] = Array.from(byParam.values());
  }
  return next;
}
