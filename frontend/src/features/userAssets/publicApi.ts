import { useEffect, useState } from "react";
import type { Input } from "mediabunny";
import type { Asset, AssetFamily, AssetFamilyCompatibility } from "../../types/Asset";
import { buildAssetFamilyCompatibility } from "../../shared/utils/assetFamilies";
import { useAssetStore } from "./useAssetStore";
import type { AssetIngestOptions } from "./services/AssetService";
import { mediaProcessingService } from "./services/MediaProcessingService";

function findAssetById(
  assets: readonly Asset[],
  assetId: string | null | undefined,
): Asset | undefined {
  if (!assetId) {
    return undefined;
  }

  return assets.find((asset) => asset.id === assetId);
}

function isHydratedAssetUrl(url: string | undefined): boolean {
  return (
    typeof url === "string" &&
    (url.startsWith("blob:") || url.startsWith("http://") || url.startsWith("https://"))
  );
}

function resolveHydratedSourceUrl(
  asset: Asset | null | undefined,
): string | null {
  return asset && isHydratedAssetUrl(asset.src) ? asset.src : null;
}

export function useAsset(assetId: string | null | undefined): Asset | undefined {
  return useAssetStore((state) => findAssetById(state.assets, assetId));
}

export function getAssets(): Asset[] {
  return useAssetStore.getState().assets;
}

function findFamilyById(
  families: readonly AssetFamily[],
  familyId: string | null | undefined,
): AssetFamily | undefined {
  if (!familyId) {
    return undefined;
  }

  return families.find((family) => family.id === familyId);
}

export function getAssetById(
  assetId: string | null | undefined,
): Asset | undefined {
  return findAssetById(useAssetStore.getState().assets, assetId);
}

export function useFamily(
  familyId: string | null | undefined,
): AssetFamily | undefined {
  return useAssetStore((state) => findFamilyById(state.families, familyId));
}

export function getFamilies(): AssetFamily[] {
  return useAssetStore.getState().families;
}

export function getFamilyById(
  familyId: string | null | undefined,
): AssetFamily | undefined {
  return findFamilyById(useAssetStore.getState().families, familyId);
}

export async function addLocalAsset(
  file: File,
  creationMetadata?: Asset["creationMetadata"],
  familyId?: Asset["familyId"],
  options?: AssetIngestOptions,
): Promise<Asset | null> {
  return useAssetStore
    .getState()
    .addLocalAsset(file, creationMetadata, familyId, options);
}

export async function addLocalAssetWithFamily(
  file: File,
  creationMetadata?: Asset["creationMetadata"],
  family?: Pick<AssetFamily, "id" | "compatibility">,
  compatibilityHint?: AssetFamilyCompatibility | null,
): Promise<Asset | null> {
  return useAssetStore
    .getState()
    .addLocalAssetWithFamily(
      file,
      creationMetadata,
      family,
      compatibilityHint,
    );
}

export async function upsertFamily(family: AssetFamily): Promise<void> {
  await useAssetStore.getState().upsertFamily(family);
}

export async function setFamilyRepresentative(
  familyId: string,
  representativeAssetId: string,
): Promise<void> {
  await useAssetStore
    .getState()
    .setFamilyRepresentative(familyId, representativeAssetId);
}

export async function deleteAsset(assetId: string): Promise<void> {
  await useAssetStore.getState().deleteAsset(assetId);
}

export async function scanForNewAssets(): Promise<void> {
  await useAssetStore.getState().scanForNewAssets();
}

export async function ensureAssetSourceLoaded(
  assetId: string,
): Promise<Asset | null> {
  return useAssetStore.getState().ensureAssetSourceLoaded(assetId);
}

export async function ensureAssetMetadataLoaded(
  assetId: string,
): Promise<Asset | null> {
  return useAssetStore.getState().ensureAssetMetadataLoaded(assetId);
}

export async function ensureAssetFileLoaded(
  assetId: string,
): Promise<File | null> {
  const asset = await useAssetStore.getState().ensureAssetSourceLoaded(assetId);
  return asset?.file ?? null;
}

export function useAssetSourceUrl(
  assetId: string | null | undefined,
  enabled = true,
): string | null {
  const asset = useAsset(assetId);
  // Mirror the asset's current hydrated URL into local state without an
  // effect by tracking the previously-observed asset reference.
  const [sourceUrl, setSourceUrl] = useState<string | null>(() =>
    resolveHydratedSourceUrl(asset),
  );
  const [lastSyncedAsset, setLastSyncedAsset] = useState(asset);
  if (lastSyncedAsset !== asset) {
    setLastSyncedAsset(asset);
    setSourceUrl(resolveHydratedSourceUrl(asset));
  }

  useEffect(() => {
    if (!enabled || !asset || resolveHydratedSourceUrl(asset)) {
      return;
    }

    let canceled = false;
    void ensureAssetSourceLoaded(asset.id).then((nextAsset) => {
      if (!canceled) {
        setSourceUrl(resolveHydratedSourceUrl(nextAsset));
      }
    });

    return () => {
      canceled = true;
    };
  }, [asset, enabled]);

  return sourceUrl;
}

export async function getAssetInput(assetId: string): Promise<Input | null> {
  return useAssetStore.getState().getInput(assetId);
}

export async function inspectAssetFamilyCompatibility(
  file: File,
): Promise<AssetFamilyCompatibility | null> {
  let candidateFile = file;

  if (
    !candidateFile.type ||
    candidateFile.type === "application/octet-stream" ||
    candidateFile.type === "text/plain"
  ) {
    const detectedMimeType = await mediaProcessingService.detectMimeType(file);
    if (detectedMimeType) {
      candidateFile = new File([file], file.name, {
        type: detectedMimeType,
      });
    }
  }

  if (candidateFile.type.startsWith("image/")) {
    return buildAssetFamilyCompatibility({
      type: "image",
      duration: 5,
    });
  }

  if (candidateFile.type.startsWith("audio/")) {
    const duration = await mediaProcessingService.computeDuration(candidateFile);
    return buildAssetFamilyCompatibility({
      type: "audio",
      duration,
    });
  }

  if (candidateFile.type.startsWith("video/")) {
    const metadata = await mediaProcessingService.generateVideoMetadata(
      candidateFile,
    );
    return buildAssetFamilyCompatibility({
      type: "video",
      duration: metadata.duration,
      fps:
        typeof metadata.fps === "number" && metadata.fps > 0
          ? metadata.fps
          : undefined,
    });
  }

  return null;
}

export async function waitForAssetPersistence(assetId: string): Promise<void> {
  await (await import("./services/AssetService")).assetService.waitForAssetPersistence(
    assetId,
  );
}

export async function waitForAssetsPersistence(
  assetIds: readonly string[],
): Promise<void> {
  await (await import("./services/AssetService")).assetService.waitForAssetsPersistence(
    assetIds,
  );
}

export async function flushAllAssetPersistence(): Promise<void> {
  await (await import("./services/AssetService")).assetService.waitForAllAssetPersistence();
}
