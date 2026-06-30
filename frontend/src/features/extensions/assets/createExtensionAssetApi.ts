import type {
  ExtensionApiScope,
  ExtensionAssetApi,
  ExtensionEntityAssetSnapshot,
} from "../types";
import {
  ensureAssetFileLoaded,
  getAssetById,
  getAssets,
} from "../../userAssets/api";
import type { Asset } from "../../../types/Asset";

function toSnapshot(asset: Asset): ExtensionEntityAssetSnapshot {
  return Object.freeze({
    id: asset.id,
    hash: asset.hash,
    name: asset.name,
    type: asset.type,
    src: asset.src,
    durationSeconds: asset.duration,
    fps: asset.fps ?? undefined,
    hasAudio: asset.hasAudio,
  });
}

export function createExtensionAssetApi(scope: ExtensionApiScope): ExtensionAssetApi {
  const api: ExtensionAssetApi = {
    list: () => Object.freeze(getAssets().map(toSnapshot)),
    get: (assetId: string) => {
      const asset = getAssetById(assetId);
      return asset ? toSnapshot(asset) : undefined;
    },
    readBlob: async (assetId: string) => {
      if (scope.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const file = await ensureAssetFileLoaded(assetId);
      if (scope.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!file) {
        throw new Error(`Asset '${assetId}' bytes are unavailable.`);
      }
      return file;
    },
  };
  return Object.freeze(api);
}
