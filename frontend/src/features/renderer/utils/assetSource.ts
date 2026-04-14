import type { Asset } from "../../../types/Asset";

/**
 * True if the asset already carries a resolvable source (an attached File, a
 * blob: URL, or a remote http(s) URL). If false, the asset needs to be
 * hydrated via `ensureAssetSourceLoaded` before it can be sent to the decoder
 * worker.
 */
export function hasEmbeddedAssetSource(asset: Asset): boolean {
  return (
    !!asset.file ||
    asset.src.startsWith("blob:") ||
    asset.src.startsWith("http://") ||
    asset.src.startsWith("https://")
  );
}
