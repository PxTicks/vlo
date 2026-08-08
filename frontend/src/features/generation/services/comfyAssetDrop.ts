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

export interface ComfyCanvasDropRequest {
  asset: Asset;
  /** Pointer position relative to the iframe viewport. */
  clientX: number;
  clientY: number;
  inputNodeMap: InputNodeMap | null;
  rawObjectInfo: Record<string, unknown> | null;
}

/**
 * Deliver an asset-browser drop onto the ComfyUI canvas: send the asset file
 * into the iframe and let the loader under the pointer take it through its own
 * drop handler (or create a fresh loader node there and hand it over).
 *
 * The bytes cross once, by structured clone. Staging them in ComfyUI's input
 * directory is the receiving node's job — core loaders and VHS each upload the
 * way their widgets expect, which the bridge cannot infer from the class name.
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

  const file = await resolveAssetFileForGeneration(request.asset);
  return iframeBridge.dropAsset({
    clientX: request.clientX,
    clientY: request.clientY,
    file,
    targets: plan.targets,
    create: plan.create,
  });
}
