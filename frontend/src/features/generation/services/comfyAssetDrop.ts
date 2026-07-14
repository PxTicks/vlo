import { API_BASE_URL } from "../../../config";
import type { Asset, AssetType } from "../../../types/Asset";
import {
  INPUT_NODE_MAP,
  resolveInputNodeMappings,
  type InputNodeMap,
} from "../constants/inputNodeMap";
import { resolveAssetFileForGeneration } from "../utils/mediaInputAssets";
import { isMemoryLoaderClassType } from "../utils/workflowClassTypes";
import {
  iframeBridge,
  type BridgeDropAssetResult,
  type BridgeDropAssetTarget,
} from "./iframeBridgeClient";

/** vloMemory loaders only take staged filenames while in-memory loading is
 * disabled on the node; the in-memory (media_id) path is a follow-up. */
const MEMORY_LOADER_DISABLE_PARAM = "disable_in_memory";

/** Node type created when a drop lands on empty canvas, first available wins.
 * VHS_LoadVideo is preferred over core LoadVideo because vlo workflows
 * predominantly use VHS nodes. */
const CREATE_NODE_PREFERENCES: Record<AssetType, readonly string[]> = {
  image: ["LoadImage"],
  video: ["VHS_LoadVideo", "LoadVideo"],
  audio: ["LoadAudio"],
  lut: [],
};

export interface ComfyAssetDropPlan {
  targets: BridgeDropAssetTarget[];
  create: { classType: string; widget: string } | null;
}

export function buildComfyAssetDropPlan(
  assetType: AssetType,
  inputNodeMap: InputNodeMap | null,
  rawObjectInfo: Record<string, unknown> | null,
): ComfyAssetDropPlan {
  const nodeMap = inputNodeMap ?? INPUT_NODE_MAP;

  const targets: BridgeDropAssetTarget[] = [];
  for (const [classType, entries] of Object.entries(nodeMap)) {
    const entry = entries.find((candidate) => candidate.inputType === assetType);
    if (!entry) continue;
    targets.push({
      classType,
      widget: entry.param,
      ...(isMemoryLoaderClassType(classType)
        ? { requiresTruthyWidget: MEMORY_LOADER_DISABLE_PARAM }
        : {}),
    });
  }

  // Trust object_info when synced; otherwise assume the core loaders exist.
  const preferences = CREATE_NODE_PREFERENCES[assetType] ?? [];
  const chosenClassType = rawObjectInfo
    ? (preferences.find((classType) => Boolean(rawObjectInfo[classType])) ?? null)
    : (preferences[0] ?? null);

  let create: ComfyAssetDropPlan["create"] = null;
  if (chosenClassType) {
    const mapping = resolveInputNodeMappings(nodeMap, chosenClassType).find(
      (entry) => entry.inputType === assetType,
    );
    if (mapping) {
      create = { classType: chosenClassType, widget: mapping.param };
    }
  }

  return { targets, create };
}

interface ComfyUploadResponse {
  name: string;
  subfolder: string;
}

function parseUploadResponse(payload: unknown): ComfyUploadResponse | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name) return null;
  return {
    name: record.name,
    subfolder: typeof record.subfolder === "string" ? record.subfolder : "",
  };
}

/**
 * Stage asset bytes in ComfyUI's input directory through the same-origin
 * proxy and return the loader widget value (filename, subfolder-qualified).
 */
export async function stageAssetInComfyInput(asset: Asset): Promise<string> {
  const file = await resolveAssetFileForGeneration(asset);
  const form = new FormData();
  form.append("image", file, file.name);
  form.append("type", "input");

  const response = await fetch(`${API_BASE_URL}/upload/image`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(`ComfyUI media upload failed (${response.status})`);
  }

  const uploaded = parseUploadResponse(await response.json().catch(() => null));
  if (!uploaded) {
    throw new Error("ComfyUI media upload returned no filename");
  }
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

export interface ComfyCanvasDropRequest {
  asset: Asset;
  /** Pointer position relative to the iframe viewport. */
  clientX: number;
  clientY: number;
  inputNodeMap: InputNodeMap | null;
  rawObjectInfo: Record<string, unknown> | null;
}

/**
 * Deliver an asset-browser drop onto the ComfyUI canvas: stage the bytes as a
 * file in ComfyUI's input directory, then ask the in-iframe bridge to point
 * the loader under the pointer at it (or create a fresh loader node there).
 */
export async function dropAssetIntoComfyCanvas(
  request: ComfyCanvasDropRequest,
): Promise<BridgeDropAssetResult> {
  const plan = buildComfyAssetDropPlan(
    request.asset.type,
    request.inputNodeMap,
    request.rawObjectInfo,
  );
  if (plan.targets.length === 0 && !plan.create) {
    throw new Error(`No ComfyUI loader accepts ${request.asset.type} assets`);
  }

  const filename = await stageAssetInComfyInput(request.asset);
  return iframeBridge.dropAsset({
    clientX: request.clientX,
    clientY: request.clientY,
    filename,
    targets: plan.targets,
    create: plan.create,
  });
}
