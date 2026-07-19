import type { ExtensionApiScope, ExtensionAssetApi } from "../types";
import {
  ensureAssetFileLoaded,
  getAssetById,
  getAssets,
  toExtensionAssetSnapshot,
} from "../../userAssets/api";
import { useAssetStore } from "../../userAssets";
import { createRevisionRelay } from "../../../core/shell/revisionRelay";
import { bindOwnerScopedSubscribe } from "../utils/ownerScopedSubscribe";
import { ingestExtensionAsset } from "./ingestExtensionAsset";

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

// Library changes replace the assets array reference; other store updates
// (preview/reveal state) keep it stable and do not signal.
const assetRevisionRelay = createRevisionRelay(useAssetStore, (state) => [
  state.assets,
]);

export function createExtensionAssetApi(scope: ExtensionApiScope): ExtensionAssetApi {
  const api: ExtensionAssetApi = {
    list: () => Object.freeze(getAssets().map(toExtensionAssetSnapshot)),
    get: (assetId: string) => {
      const asset = getAssetById(assetId);
      return asset ? toExtensionAssetSnapshot(asset) : undefined;
    },
    readBlob: async (assetId: string) => {
      abortIfNeeded(scope.signal);
      const file = await ensureAssetFileLoaded(assetId);
      abortIfNeeded(scope.signal);
      if (!file) {
        throw new Error(`Asset '${assetId}' bytes are unavailable.`);
      }
      return file;
    },
    ingest: (input) => ingestExtensionAsset(input, scope.signal),
    subscribe: bindOwnerScopedSubscribe(scope, assetRevisionRelay, "Asset"),
    getRevision: () => assetRevisionRelay.getRevision(),
  };
  return Object.freeze(api);
}
