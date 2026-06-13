import type { Asset } from "../../types/Asset";

export interface AssetRegenerator {
  canRegenerate: (asset: Asset) => boolean;
  regenerate: (asset: Asset) => Promise<void>;
}

let registeredAssetRegenerator: AssetRegenerator | null = null;

export function registerAssetRegenerator(
  assetRegenerator: AssetRegenerator,
): () => void {
  registeredAssetRegenerator = assetRegenerator;

  return () => {
    if (registeredAssetRegenerator === assetRegenerator) {
      registeredAssetRegenerator = null;
    }
  };
}

export function getAssetRegenerator(): AssetRegenerator | null {
  return registeredAssetRegenerator;
}

export function canRegenerateAsset(asset: Asset): boolean {
  return registeredAssetRegenerator?.canRegenerate(asset) ?? false;
}

export async function regenerateAsset(asset: Asset): Promise<void> {
  const assetRegenerator = registeredAssetRegenerator;
  if (!assetRegenerator?.canRegenerate(asset)) {
    throw new Error("Regeneration is unavailable for this asset.");
  }

  await assetRegenerator.regenerate(asset);
}
