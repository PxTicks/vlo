import type { ExtensionApiScope, ExtensionAssetApi } from "../types";
import {
  ensureAssetFileLoaded,
  getAssetById,
  getAssets,
  toExtensionAssetSnapshot,
} from "../../userAssets/api";

export function createExtensionAssetApi(scope: ExtensionApiScope): ExtensionAssetApi {
  const api: ExtensionAssetApi = {
    list: () => Object.freeze(getAssets().map(toExtensionAssetSnapshot)),
    get: (assetId: string) => {
      const asset = getAssetById(assetId);
      return asset ? toExtensionAssetSnapshot(asset) : undefined;
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
