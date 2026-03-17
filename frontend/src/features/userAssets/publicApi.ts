import type { Input } from "mediabunny";
import type { Asset } from "../../types/Asset";
import { useAssetStore } from "./useAssetStore";

function findAssetById(
  assets: readonly Asset[],
  assetId: string | null | undefined,
): Asset | undefined {
  if (!assetId) {
    return undefined;
  }

  return assets.find((asset) => asset.id === assetId);
}

export function useAsset(assetId: string | null | undefined): Asset | undefined {
  return useAssetStore((state) => findAssetById(state.assets, assetId));
}

export function getAssets(): Asset[] {
  return useAssetStore.getState().assets;
}

export function getAssetById(
  assetId: string | null | undefined,
): Asset | undefined {
  return findAssetById(useAssetStore.getState().assets, assetId);
}

export async function addLocalAsset(
  file: File,
  creationMetadata?: Asset["creationMetadata"],
): Promise<Asset | null> {
  return useAssetStore.getState().addLocalAsset(file, creationMetadata);
}

export async function deleteAsset(assetId: string): Promise<void> {
  await useAssetStore.getState().deleteAsset(assetId);
}

export async function scanForNewAssets(): Promise<void> {
  await useAssetStore.getState().scanForNewAssets();
}

export async function getAssetInput(assetId: string): Promise<Input | null> {
  return useAssetStore.getState().getInput(assetId);
}
