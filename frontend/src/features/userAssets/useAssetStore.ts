import { create } from "zustand";
import { Input, UrlSource, BlobSource, ALL_FORMATS } from "mediabunny";
import type {
  Asset,
  AssetFamily,
  AssetFamilyCompatibility,
} from "../../types/Asset";
import { doesAssetBelongToFamily } from "../../shared/utils/assetFamilies";
import {
  useProjectStore,
  fileSystemService,
  projectPersistenceService,
  type PersistedAssetIndexEntry,
} from "../project";
import { mediaProcessingService } from "./services/MediaProcessingService";

export interface AddLocalAssetsResult {
  assets: Asset[];
  skippedExistingFiles: number;
}

interface AssetStore {
  assets: Asset[];
  families: AssetFamily[];
  isUploading: boolean;
  uploadingCount: number;
  isScanning: boolean; // Add scanning lock
  isLoading: boolean;
  inputCache: Map<string, Input>;
  uploadAsset: (file: File) => Promise<void>;
  addLocalAsset: (
    file: File,
    creationMetadata?: Asset["creationMetadata"],
    familyId?: Asset["familyId"],
  ) => Promise<Asset | null>;
  addLocalAssets: (
    files: readonly File[],
    creationMetadata?: Asset["creationMetadata"],
    familyId?: Asset["familyId"],
  ) => Promise<AddLocalAssetsResult>;
  addLocalAssetWithFamily: (
    file: File,
    creationMetadata?: Asset["creationMetadata"],
    family?: Pick<AssetFamily, "id" | "compatibility">,
    compatibilityHint?: AssetFamilyCompatibility | null,
  ) => Promise<Asset | null>;
  upsertFamily: (family: AssetFamily) => Promise<void>;
  setFamilyRepresentative: (
    familyId: string,
    representativeAssetId: string,
  ) => Promise<void>;
  updateAsset: (id: string, updates: Partial<Asset>) => Promise<void>;
  fetchAssets: () => Promise<void>;
  scanForNewAssets: () => Promise<void>;
  ensureAssetSourceLoaded: (assetId: string) => Promise<Asset | null>;
  ensureAssetMetadataLoaded: (assetId: string) => Promise<Asset | null>;
  getInput: (assetId: string) => Promise<Input | null>;
  deleteAsset: (id: string) => Promise<void>;
}

type AssetStoreSet = (
  partial:
    | Partial<AssetStore>
    | ((state: AssetStore) => Partial<AssetStore>),
) => void;

interface AssetDurationRepair {
  id: string;
  duration: number;
}

function hasValidDuration(duration: number | undefined): duration is number {
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0;
}

function isHydratedAssetUrl(url: string | undefined): boolean {
  return (
    typeof url === "string" &&
    (url.startsWith("blob:") || url.startsWith("http://") || url.startsWith("https://"))
  );
}

function revokeBlobUrl(url: string | undefined): void {
  if (typeof url === "string" && url.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

function disposeInput(input: Input | undefined): void {
  if (!input) {
    return;
  }

  try {
    input.dispose();
  } catch (error) {
    console.warn("[AssetStore] Failed to dispose cached media input", error);
  }
}

function disposeAssetRuntimeResources(asset: Asset | undefined): void {
  if (!asset) {
    return;
  }

  revokeBlobUrl(asset.src);
  revokeBlobUrl(asset.thumbnail);
  revokeBlobUrl(asset.proxySrc);
}

function disposeAssetCollectionRuntimeResources(
  assets: readonly Asset[],
  inputCache: ReadonlyMap<string, Input>,
): void {
  for (const asset of assets) {
    disposeAssetRuntimeResources(asset);
    disposeInput(inputCache.get(asset.id));
  }
}

const sourceHydrationPromises = new Map<string, Promise<Asset | null>>();
const metadataHydrationPromises = new Map<string, Promise<Asset | null>>();

function toAssetFamilyRecordMap(
  families: readonly AssetFamily[],
): Record<string, AssetFamily> {
  return Object.fromEntries(families.map((family) => [family.id, family]));
}

function upsertFamilyInCollection(
  families: readonly AssetFamily[],
  family: AssetFamily,
): AssetFamily[] {
  const index = families.findIndex((candidate) => candidate.id === family.id);
  if (index < 0) {
    return [...families, family];
  }

  const nextFamilies = [...families];
  nextFamilies[index] = family;
  return nextFamilies;
}

function pickRepresentativeAssetIdForFamily(
  assets: readonly Asset[],
  family: AssetFamily,
): string | undefined {
  return assets
    .filter((asset) => doesAssetBelongToFamily(asset, family))
    .sort((left, right) => {
      const createdAtDifference = (right.createdAt || 0) - (left.createdAt || 0);
      if (createdAtDifference !== 0) {
        return createdAtDifference;
      }

      return left.name.localeCompare(right.name);
    })[0]?.id;
}

function isRepresentativeAssetIdValidForFamily(
  assets: readonly Asset[],
  family: AssetFamily,
  representativeAssetId: string | undefined,
): representativeAssetId is string {
  if (!representativeAssetId) {
    return false;
  }

  const representativeAsset = assets.find(
    (asset) => asset.id === representativeAssetId,
  );
  return Boolean(
    representativeAsset && doesAssetBelongToFamily(representativeAsset, family),
  );
}

function setRepresentativeAssetIdForFamily(
  assets: readonly Asset[],
  families: readonly AssetFamily[],
  familyId: string,
  representativeAssetId: string,
  updatedAt = Date.now(),
): AssetFamily[] {
  const family = families.find((candidate) => candidate.id === familyId);
  if (!family) {
    return [...families];
  }

  const representativeAsset = assets.find(
    (asset) => asset.id === representativeAssetId,
  );
  if (
    !representativeAsset ||
    !doesAssetBelongToFamily(representativeAsset, family) ||
    family.representativeAssetId === representativeAssetId
  ) {
    return [...families];
  }

  return families.map((candidate) =>
    candidate.id === familyId
      ? {
          ...candidate,
          representativeAssetId,
          updatedAt,
        }
      : candidate,
  );
}

function syncAssetFamilyIdsToDraftAssets(
  draftAssets:
    | Record<string, Pick<PersistedAssetIndexEntry, "familyId">>
    | undefined,
  assets: readonly Asset[],
): void {
  if (!draftAssets) {
    return;
  }

  for (const asset of assets) {
    if (!draftAssets[asset.id]) {
      continue;
    }

    draftAssets[asset.id].familyId = asset.familyId;
  }
}

function syncFamiliesToDraft(
  draft: { assetFamilies: Record<string, AssetFamily> },
  families: readonly AssetFamily[],
): void {
  draft.assetFamilies = toAssetFamilyRecordMap(families);
}

function clearInvalidFamilyReferences(
  assets: readonly Asset[],
  families: readonly AssetFamily[],
): Asset[] {
  const familiesById = new Map(families.map((family) => [family.id, family]));

  return assets.map((asset) => {
    if (!asset.familyId) {
      return asset;
    }

    const family = familiesById.get(asset.familyId);
    if (!family || !doesAssetBelongToFamily(asset, family)) {
      return {
        ...asset,
        familyId: undefined,
      };
    }

    return asset;
  });
}

function reconcileFamiliesWithAssets(
  assets: readonly Asset[],
  families: readonly AssetFamily[],
  updatedAt = Date.now(),
): AssetFamily[] {
  return families.flatMap((family) => {
    const representativeAssetId = isRepresentativeAssetIdValidForFamily(
      assets,
      family,
      family.representativeAssetId,
    )
      ? family.representativeAssetId
      : pickRepresentativeAssetIdForFamily(assets, family);
    if (!representativeAssetId) {
      return [];
    }

    if (family.representativeAssetId === representativeAssetId) {
      return [family];
    }

    return [
      {
        ...family,
        representativeAssetId,
        updatedAt,
      },
    ];
  });
}

function sanitizeAssetFamilyState(
  assets: readonly Asset[],
  families: readonly AssetFamily[],
  updatedAt = Date.now(),
): { assets: Asset[]; families: AssetFamily[] } {
  const nextAssets = clearInvalidFamilyReferences(assets, families);
  const nextFamilies = reconcileFamiliesWithAssets(nextAssets, families, updatedAt);

  return {
    assets: nextAssets,
    families: nextFamilies,
  };
}

async function ingestLocalAssetsIntoStore(
  get: () => AssetStore,
  set: AssetStoreSet,
  files: readonly File[],
  creationMetadata?: Asset["creationMetadata"],
  family?: Pick<AssetFamily, "id" | "compatibility">,
  compatibilityHint?: AssetFamilyCompatibility | null,
): Promise<AddLocalAssetsResult> {
  const returnedAssets: Asset[] = [];
  const newlyCreatedAssets: Asset[] = [];
  let skippedExistingFiles = 0;

  if (files.length === 0) {
    return {
      assets: returnedAssets,
      skippedExistingFiles,
    };
  }

  set((state) => ({
    uploadingCount: state.uploadingCount + 1,
    isUploading: true,
  }));

  try {
    const { assetService } = await import("./services/AssetService");
    const assets = [...get().assets];

    for (const file of files) {
      const ingestResult = await assetService.ingestAssetWithResult(
        file,
        false,
        false,
        assets,
        creationMetadata,
        family,
        compatibilityHint,
      );

      if (ingestResult.status === "skipped_existing") {
        skippedExistingFiles += 1;
        continue;
      }

      if (ingestResult.status === "reused_existing") {
        // Existing record stays in the store; surface it so callers can link
        // (e.g. a generated asset pointing to a shared generation mask).
        returnedAssets.push(ingestResult.asset);
        continue;
      }

      if (ingestResult.status !== "created") {
        continue;
      }

      assets.push(ingestResult.asset);
      newlyCreatedAssets.push(ingestResult.asset);
      returnedAssets.push(ingestResult.asset);
    }

    if (newlyCreatedAssets.length > 0) {
      set((state) => ({
        assets: [...state.assets, ...newlyCreatedAssets],
      }));
    }

    return {
      assets: returnedAssets,
      skippedExistingFiles,
    };
  } finally {
    set((state) => {
      const uploadingCount = Math.max(0, state.uploadingCount - 1);
      return {
        uploadingCount,
        isUploading: uploadingCount > 0,
      };
    });
  }
}

function countGenerationMaskAssetConsumers(
  assets: readonly Asset[],
  maskAssetId: string | null | undefined,
): number {
  if (!maskAssetId) {
    return 0;
  }

  return assets.reduce((count, asset) => {
    const metadata = asset.creationMetadata;
    const isConsumer =
      metadata?.source === "generated" &&
      metadata.generationMaskAssetId === maskAssetId;
    return count + (isConsumer ? 1 : 0);
  }, 0);
}

async function resolveAssetDurationRepair(
  asset: Asset,
  file: File | undefined,
): Promise<number | undefined> {
  if (asset.type === "image" || hasValidDuration(asset.duration) || !file) {
    return undefined;
  }

  const repairedDuration = await mediaProcessingService.computeDuration(file);
  if (!hasValidDuration(repairedDuration)) {
    return undefined;
  }

  return repairedDuration;
}

export const useAssetStore = create<AssetStore>((set, get) => ({
  assets: [],
  families: [],
  isUploading: false,
  uploadingCount: 0,
  isScanning: false,
  isLoading: false,
  inputCache: new Map(),

  fetchAssets: async () => {
    const { rootHandle } = useProjectStore.getState();
    if (!rootHandle) return;

    set({ isLoading: true });
    try {
      const previousAssets = get().assets;
      const previousInputCache = new Map(get().inputCache);
      const data = await projectPersistenceService.readAssetIndex();
      const assetsMap = data.assets;
      const assetFamiliesMap = data.assetFamilies;
      const durationRepairs: AssetDurationRepair[] = [];

      // Hydrate paths to Blob URLs
      const loadedAssets: Asset[] = await Promise.all(
        Object.values(assetsMap).map(async (rawAsset) => {
          try {
            // 1. Resolve Main Source
            let src = rawAsset.src;
            let fileObj: File | undefined;
            const sourcePath = !isHydratedAssetUrl(rawAsset.src)
              ? rawAsset.src
              : undefined;

            if (
              sourcePath &&
              rawAsset.type !== "video"
            ) {
              try {
                fileObj = await fileSystemService.readFile(sourcePath);
                src = URL.createObjectURL(fileObj);
              } catch (e) {
                console.warn(`Failed to read asset file: ${src}`, e);
              }
            }

            // 2. Resolve Thumbnail
            let thumbnail = rawAsset.thumbnail;
            const thumbnailPath =
              thumbnail && !isHydratedAssetUrl(thumbnail) ? thumbnail : undefined;
            if (
              thumbnailPath
            ) {
              try {
                const thumbFile = await fileSystemService.readFile(thumbnailPath);
                thumbnail = URL.createObjectURL(thumbFile);
              } catch (e) {
                console.warn(`Failed to read thumbnail: ${thumbnail}`, e);
              }
            }

            // 3. Resolve Proxy
            let proxySrc = rawAsset.proxySrc;
            let proxyFile: Blob | undefined;
            const proxyPath =
              proxySrc && !isHydratedAssetUrl(proxySrc) ? proxySrc : undefined;
            if (
              proxyPath
            ) {
              try {
                const proxyBlob = await fileSystemService.readFile(proxyPath);
                proxyFile = proxyBlob;
                proxySrc = URL.createObjectURL(proxyBlob);
              } catch (e) {
                console.warn(`Failed to read proxy: ${proxySrc}`, e);
              }
            }

            const repairedDuration = await resolveAssetDurationRepair(
              rawAsset,
              fileObj ?? (proxyFile instanceof File ? proxyFile : undefined),
            );
            if (repairedDuration !== undefined) {
              durationRepairs.push({
                id: rawAsset.id,
                duration: repairedDuration,
              });
            }

            return {
              ...rawAsset,
              src,
              sourcePath,
              thumbnail,
              thumbnailPath,
              proxySrc,
              proxyPath,
              metadataRef: rawAsset.metadataRef,
              metadataLoaded: !rawAsset.metadataRef,
              proxyFile,
              file: fileObj,
              duration: repairedDuration ?? rawAsset.duration,
            };
          } catch (e) {
            console.error(`Error hydrating asset ${rawAsset.id}`, e);
            // Return rawAsset or null? Better to filter out failed ones or return partial?
            // Returning rawAsset might break things if src is invalid path.
            // Let's return rawAsset but with logged error, maybe UI handles it.
            return rawAsset;
          }
        }),
      );

      if (durationRepairs.length > 0) {
        try {
          await projectPersistenceService.updateAssetIndex((draft) => {
            for (const repair of durationRepairs) {
              const asset = draft.assets[repair.id];
              if (!asset) continue;
              asset.duration = repair.duration;
            }
          });
        } catch (error) {
          console.warn("Failed to persist repaired asset durations", error);
        }
      }

      const loadedFamilies = Object.values(assetFamiliesMap);
      const sanitizedState = sanitizeAssetFamilyState(loadedAssets, loadedFamilies);

      set({
        assets: sanitizedState.assets,
        families: sanitizedState.families,
        inputCache: new Map(),
      });
      disposeAssetCollectionRuntimeResources(previousAssets, previousInputCache);
    } catch (err) {
      console.error("Failed to load assets from assets.json", err);
    } finally {
      set({ isLoading: false });
    }
  },

  scanForNewAssets: async () => {
    if (get().isScanning) {
      console.warn("[Scanner] Scan already in progress.");
      return;
    }

    console.log("[Scanner] Starting scan...");
    set((state) => ({
      isScanning: true,
      uploadingCount: state.uploadingCount + 1,
      isUploading: true,
    }));
    try {
      const { assets } = get();
      const { assetService } = await import("./services/AssetService");

      const newAssets = await assetService.scanForNewAssets(assets);

      if (newAssets.length > 0) {
        set((state) => ({
          assets: [...state.assets, ...newAssets],
        }));
      }
    } catch (e) {
      console.error("Failed to scan assets directory", e);
    } finally {
      console.log("[Scanner] Scan complete.");
      set((state) => {
        const uploadingCount = Math.max(0, state.uploadingCount - 1);
        return {
          isScanning: false,
          uploadingCount,
          isUploading: uploadingCount > 0,
        };
      });
    }
  },

  uploadAsset: async () => {
    console.warn("uploadAsset is deprecated. Use addLocalAsset.");
  },

  addLocalAsset: async (
    file: File,
    creationMetadata?: Asset["creationMetadata"],
    familyId?: Asset["familyId"],
  ) => {
    const family = familyId
      ? get().families.find((candidate) => candidate.id === familyId)
      : undefined;

    if (familyId && !family) {
      console.warn(
        `[AssetStore] Skipping family assignment because family '${familyId}' was not found.`,
      );
    }

    const result = await ingestLocalAssetsIntoStore(
      get,
      set,
      [file],
      creationMetadata,
      family,
    );
    return result.assets[0] ?? null;
  },

  addLocalAssets: async (
    files: readonly File[],
    creationMetadata?: Asset["creationMetadata"],
    familyId?: Asset["familyId"],
  ) => {
    const family = familyId
      ? get().families.find((candidate) => candidate.id === familyId)
      : undefined;

    if (familyId && !family) {
      console.warn(
        `[AssetStore] Skipping family assignment because family '${familyId}' was not found.`,
      );
    }

    return ingestLocalAssetsIntoStore(
      get,
      set,
      files,
      creationMetadata,
      family,
    );
  },

  addLocalAssetWithFamily: async (
    file: File,
    creationMetadata?: Asset["creationMetadata"],
    family?: Pick<AssetFamily, "id" | "compatibility">,
    compatibilityHint?: AssetFamilyCompatibility | null,
  ) => {
    const result = await ingestLocalAssetsIntoStore(
      get,
      set,
      [file],
      creationMetadata,
      family,
      compatibilityHint,
    );
    return result.assets[0] ?? null;
  },

  ensureAssetSourceLoaded: async (assetId: string) => {
    const existingAsset = get().assets.find((asset) => asset.id === assetId);
    if (!existingAsset) {
      return null;
    }

    if (existingAsset.file || isHydratedAssetUrl(existingAsset.src)) {
      return existingAsset;
    }

    const existingPromise = sourceHydrationPromises.get(assetId);
    if (existingPromise) {
      return existingPromise;
    }

    const hydrationPromise = (async () => {
      const currentAsset = get().assets.find((asset) => asset.id === assetId);
      if (!currentAsset) {
        return null;
      }

      const sourcePath =
        currentAsset.sourcePath ??
        (!isHydratedAssetUrl(currentAsset.src) ? currentAsset.src : undefined);
      if (!sourcePath) {
        return currentAsset;
      }

      const file = await fileSystemService.readFile(sourcePath);
      const sourceUrl = URL.createObjectURL(file);
      let hydratedAsset: Asset | null = null;

      set((state) => {
        const nextAssets = state.assets.map((asset) => {
          if (asset.id !== assetId) {
            return asset;
          }

          if (asset.src !== sourceUrl) {
            revokeBlobUrl(asset.src);
          }

          const nextAsset: Asset = {
            ...asset,
            src: sourceUrl,
            sourcePath,
            file,
          };
          hydratedAsset = nextAsset;
          return nextAsset;
        });

        return {
          assets: nextAssets,
        };
      });

      return hydratedAsset ?? get().assets.find((asset) => asset.id === assetId) ?? null;
    })().finally(() => {
      sourceHydrationPromises.delete(assetId);
    });

    sourceHydrationPromises.set(assetId, hydrationPromise);
    return hydrationPromise;
  },

  ensureAssetMetadataLoaded: async (assetId: string) => {
    const existingAsset = get().assets.find((asset) => asset.id === assetId);
    if (!existingAsset) {
      return null;
    }

    if (!existingAsset.metadataRef || existingAsset.metadataLoaded) {
      return existingAsset;
    }

    const existingPromise = metadataHydrationPromises.get(assetId);
    if (existingPromise) {
      return existingPromise;
    }

    const hydrationPromise = (async () => {
      const currentAsset = get().assets.find((asset) => asset.id === assetId);
      if (!currentAsset) {
        return null;
      }

      if (!currentAsset.metadataRef || currentAsset.metadataLoaded) {
        return currentAsset;
      }

      const metadataDocument = await projectPersistenceService.readAssetMetadata(
        currentAsset.id,
        currentAsset.metadataRef,
      );
      let hydratedAsset: Asset | null = null;

      set((state) => {
        const nextAssets = state.assets.map((asset) => {
          if (asset.id !== assetId) {
            return asset;
          }

          const nextAsset: Asset = {
            ...asset,
            creationMetadata:
              metadataDocument?.creationMetadata ?? asset.creationMetadata,
            metadataLoaded: true,
          };
          hydratedAsset = nextAsset;
          return nextAsset;
        });

        return {
          assets: nextAssets,
        };
      });

      return hydratedAsset ?? get().assets.find((asset) => asset.id === assetId) ?? null;
    })().finally(() => {
      metadataHydrationPromises.delete(assetId);
    });

    metadataHydrationPromises.set(assetId, hydrationPromise);
    return hydrationPromise;
  },

  upsertFamily: async (family: AssetFamily) => {
    const previousAssets = get().assets;
    const previousFamilies = get().families;
    const sanitizedState = sanitizeAssetFamilyState(
      previousAssets,
      upsertFamilyInCollection(previousFamilies, family),
    );
    set(sanitizedState);

    try {
      await projectPersistenceService.updateAssetIndex((draft) => {
        syncAssetFamilyIdsToDraftAssets(draft.assets, sanitizedState.assets);
        syncFamiliesToDraft(draft, sanitizedState.families);
      });
    } catch (error) {
      console.error(
        `Failed to persist asset family update for '${family.id}'`,
        error,
      );
      set({ assets: previousAssets, families: previousFamilies });
    }
  },

  setFamilyRepresentative: async (familyId: string, representativeAssetId: string) => {
    const previousAssets = get().assets;
    const previousFamilies = get().families;
    const updatedAt = Date.now();
    const nextFamilies = setRepresentativeAssetIdForFamily(
      previousAssets,
      previousFamilies,
      familyId,
      representativeAssetId,
      updatedAt,
    );

    if (
      nextFamilies.length === previousFamilies.length &&
      nextFamilies.every((family, index) => family === previousFamilies[index])
    ) {
      return;
    }

    const sanitizedState = sanitizeAssetFamilyState(
      previousAssets,
      nextFamilies,
      updatedAt,
    );
    set(sanitizedState);

    try {
      await projectPersistenceService.updateAssetIndex((draft) => {
        syncAssetFamilyIdsToDraftAssets(draft.assets, sanitizedState.assets);
        syncFamiliesToDraft(draft, sanitizedState.families);
      });
    } catch (error) {
      console.error(
        `Failed to persist representative update for family '${familyId}'`,
        error,
      );
      set({ assets: previousAssets, families: previousFamilies });
    }
  },

  updateAsset: async (id: string, updates: Partial<Asset>) => {
    const previousAsset = get().assets.find((asset) => asset.id === id);
    if (!previousAsset) {
      return;
    }

    const previousAssets = get().assets;
    const previousFamilies = get().families;
    const updatedAt = Date.now();
    const nextAssets = previousAssets.map((asset) =>
      asset.id === id ? { ...asset, ...updates } : asset,
    );
    const nextUpdatedAsset = nextAssets.find((asset) => asset.id === id);
    const nextFamilies =
      updates.favourite === true && nextUpdatedAsset?.familyId
        ? setRepresentativeAssetIdForFamily(
            nextAssets,
            previousFamilies,
            nextUpdatedAsset.familyId,
            nextUpdatedAsset.id,
            updatedAt,
          )
        : [...previousFamilies];
    const sanitizedState = sanitizeAssetFamilyState(
      nextAssets,
      nextFamilies,
      updatedAt,
    );

    set(sanitizedState);

    try {
      const nextAsset = sanitizedState.assets.find((asset) => asset.id === id);
      let persistedEntry: PersistedAssetIndexEntry | null = null;
      if (nextAsset) {
        persistedEntry = await projectPersistenceService.persistAssetEntry(nextAsset);
      }

      await projectPersistenceService.updateAssetIndex((draft) => {
        if (!draft.assets[id]) {
          return;
        }

        syncAssetFamilyIdsToDraftAssets(draft.assets, sanitizedState.assets);

        if (nextAsset && persistedEntry) {
          draft.assets[id] = {
            ...draft.assets[id],
            ...persistedEntry,
            familyId: nextAsset.familyId,
          };
        }

        syncFamiliesToDraft(draft, sanitizedState.families);
      });
    } catch (error) {
      console.error(`Failed to persist asset update for '${id}'`, error);
      set({ assets: previousAssets, families: previousFamilies });
    }
  },

  getInput: async (assetId: string) => {
    const { inputCache } = get();
    if (inputCache.has(assetId)) {
      return inputCache.get(assetId)!;
    }

    let asset: Asset | null = get().assets.find((a) => a.id === assetId) ?? null;
    if (!asset) return null;

    if (!asset.file && !isHydratedAssetUrl(asset.src)) {
      asset = await get().ensureAssetSourceLoaded(assetId);
      if (!asset) {
        return null;
      }
    }

    try {
      const source = asset.file
        ? new BlobSource(asset.file)
        : new UrlSource(asset.src, { maxCacheSize: 16 * 1024 * 1024 });

      const input = new Input({
        source,
        formats: ALL_FORMATS,
      });
      inputCache.set(assetId, input);
      return input;
    } catch (error) {
      console.error("Failed to create input", error);
      return null;
    }
  },

  deleteAsset: async (id: string) => {
    const assetToDelete = get().assets.find((a) => a.id === id);
    const cachedInput = get().inputCache.get(id);
    if (
      assetToDelete?.creationMetadata?.source === "generation_mask" &&
      countGenerationMaskAssetConsumers(get().assets, id) > 0
    ) {
      console.warn(
        `[AssetStore] Skipping generation mask deletion for '${id}' because generated assets still reference it.`,
      );
      return;
    }

    if (!assetToDelete) {
      return;
    }

    try {
      const { useTimelineStore } = await import("../timeline");
      useTimelineStore.getState().removeClipsByAssetId(id);
    } catch (error) {
      console.warn(
        `[AssetStore] Failed to remove timeline clips for asset '${id}'`,
        error,
      );
    }

    // 1. Remove the live index entry first so failed physical cleanup leaves an orphan file, not a broken asset.
    let pathsToDelete: {
      src?: string;
      thumbnail?: string;
      proxySrc?: string;
    } = {};
    let metadataRefToDelete: string | undefined;
    const nextAssets = get().assets.filter((asset) => asset.id !== id);
    const sanitizedState = sanitizeAssetFamilyState(nextAssets, get().families);

    try {
      await projectPersistenceService.updateAssetIndex((draft) => {
        if (!draft.assets[id]) return;

        const storedAsset = draft.assets[id];
        pathsToDelete = {
          src: storedAsset.src,
          thumbnail: storedAsset.thumbnail,
          proxySrc: storedAsset.proxySrc,
        };
        metadataRefToDelete = storedAsset.metadataRef;

        delete draft.assets[id];

        syncAssetFamilyIdsToDraftAssets(draft.assets, sanitizedState.assets);
        syncFamiliesToDraft(draft, sanitizedState.families);
      });
    } catch (e) {
      console.error("Failed to update assets.json during deletion", e);
      // If we can't read/write assets.json, we might fail to get paths,
      // but we should still try to clean up memory.
    }

    // 2. Remove from memory immediately for UI responsiveness
    set((state) => {
      const nextInputCache = new Map(state.inputCache);
      nextInputCache.delete(id);
      return {
        assets: sanitizedState.assets,
        families: sanitizedState.families,
        inputCache: nextInputCache,
      };
    });
    disposeInput(cachedInput);
    disposeAssetRuntimeResources(assetToDelete);

    if (metadataRefToDelete) {
      try {
        await projectPersistenceService.deleteAssetMetadata(id, metadataRefToDelete);
      } catch (e) {
        console.warn("Failed to delete asset metadata sidecar", e);
      }
    }

    // 3. Delete files from disk using paths found in the index
    if (pathsToDelete.src) {
      // Only delete if it looks like a local path (not http/blob)
      if (
        !pathsToDelete.src.startsWith("http") &&
        !pathsToDelete.src.startsWith("blob:")
      ) {
        try {
          await fileSystemService.deleteFile(pathsToDelete.src);
        } catch (e) {
          console.error("Failed to delete source file", e);
        }
      }
    }

    if (pathsToDelete.thumbnail) {
      if (
        !pathsToDelete.thumbnail.startsWith("http") &&
        !pathsToDelete.thumbnail.startsWith("blob:")
      ) {
        try {
          await fileSystemService.deleteFile(pathsToDelete.thumbnail);
        } catch (e) {
          console.warn("Failed to delete thumbnail file", e);
        }
      }
    }

    if (pathsToDelete.proxySrc) {
      if (
        !pathsToDelete.proxySrc.startsWith("http") &&
        !pathsToDelete.proxySrc.startsWith("blob:")
      ) {
        try {
          await fileSystemService.deleteFile(pathsToDelete.proxySrc);
        } catch (e) {
          console.warn("Failed to delete proxy file", e);
        }
      }
    }

    if (
      assetToDelete?.creationMetadata?.source === "generated" &&
      assetToDelete.creationMetadata.generationMaskAssetId
    ) {
      const maskId = assetToDelete.creationMetadata.generationMaskAssetId;
      const remainingConsumers = countGenerationMaskAssetConsumers(
        get().assets,
        maskId,
      );

      if (remainingConsumers === 0) {
        await get().deleteAsset(maskId);
      }
    }
  },
}));
// DEBUG: expose for console diagnostics
(window as unknown as Record<string, unknown>).__ASSET_STORE__ = useAssetStore;
