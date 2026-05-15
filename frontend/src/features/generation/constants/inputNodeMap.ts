import type { WorkflowInput } from "../types";
import { getWorkflowClassTypeLookupKeys } from "../utils/workflowClassTypes";

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
 * object_info metadata (for example VHS video-loader nodes that do not expose
 * a ``video_upload`` flag in object_info).
 *
 * At runtime this is merged with the dynamic map built from object_info by
 * the backend's ``/object_info/sync`` endpoint.
 */
const STATIC_INPUT_NODE_MAP: InputNodeMap = {
  LoadImage: [{ inputType: "image", param: "image", label: "Image" }],
  vloMemoryLoadImage: [{ inputType: "image", param: "image", label: "Image" }],
  CLIPTextEncode: [{ inputType: "text", param: "text", label: "Prompt" }],
  LoadAudio: [{ inputType: "audio", param: "audio", label: "Audio" }],
  vloMemoryLoadAudio: [{ inputType: "audio", param: "audio", label: "Audio" }],
  LoadVideo: [{ inputType: "video", param: "file", label: "Video" }],
  vloMemoryLoadVideo: [{ inputType: "video", param: "file", label: "Video" }],
  VHS_LoadVideo: [{ inputType: "video", param: "video", label: "Video" }],
  VHS_LoadVideoFFmpeg: [{ inputType: "video", param: "video", label: "Video" }],
};

function withWorkflowClassTypeAliases(inputNodeMap: InputNodeMap): InputNodeMap {
  const expanded: InputNodeMap = { ...inputNodeMap };

  for (const [classType, entries] of Object.entries(inputNodeMap)) {
    for (const key of getWorkflowClassTypeLookupKeys(classType)) {
      expanded[key] ??= entries;
    }
  }

  return expanded;
}

export const INPUT_NODE_MAP: InputNodeMap =
  withWorkflowClassTypeAliases(STATIC_INPUT_NODE_MAP);

export function resolveInputNodeMappings(
  inputNodeMap: InputNodeMap,
  classType: string | null | undefined,
): InputNodeMapEntry[] {
  for (const key of getWorkflowClassTypeLookupKeys(classType)) {
    const mappings = inputNodeMap[key];
    if (mappings && mappings.length > 0) {
      return mappings;
    }
  }

  return [];
}

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
        inputType === "audio" ||
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
  return withWorkflowClassTypeAliases(next);
}
