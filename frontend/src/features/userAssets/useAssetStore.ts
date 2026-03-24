import { create } from "zustand";
import { Input, UrlSource, BlobSource, ALL_FORMATS } from "mediabunny";
import type { Asset } from "../../types/Asset";
import {
  useProjectStore,
  fileSystemService,
  projectDocumentService,
} from "../project";
import { mediaProcessingService } from "./services/MediaProcessingService";

interface AssetStore {
  assets: Asset[];
  isUploading: boolean;
  uploadingCount: number;
  isScanning: boolean; // Add scanning lock
  isLoading: boolean;
  inputCache: Map<string, Input>;
  uploadAsset: (file: File) => Promise<void>;
  addLocalAsset: (
    file: File,
    creationMetadata?: Asset["creationMetadata"],
  ) => Promise<Asset | null>;
  addLocalAssets: (
    files: readonly File[],
    creationMetadata?: Asset["creationMetadata"],
  ) => Promise<Asset[]>;
  updateAsset: (id: string, updates: Partial<Asset>) => Promise<void>;
  fetchAssets: () => Promise<void>;
  scanForNewAssets: () => Promise<void>;
  getInput: (assetId: string) => Promise<Input | null>;
  deleteAsset: (id: string) => Promise<void>;
}

interface AssetDurationRepair {
  id: string;
  duration: number;
}

function hasValidDuration(duration: number | undefined): duration is number {
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0;
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
      const data = await projectDocumentService.readProjectDocument();
      const assetsMap = (data.assets || {}) as Record<string, Asset>;
      const durationRepairs: AssetDurationRepair[] = [];

      // Hydrate paths to Blob URLs
      const loadedAssets: Asset[] = await Promise.all(
        Object.values(assetsMap).map(async (rawAsset) => {
          try {
            // 1. Resolve Main Source
            let src = rawAsset.src;
            let fileObj: File | undefined;

            if (!src.startsWith("http") && !src.startsWith("blob:")) {
              try {
                fileObj = await fileSystemService.readFile(src);
                src = URL.createObjectURL(fileObj);
              } catch (e) {
                console.warn(`Failed to read asset file: ${src}`, e);
              }
            }

            // 2. Resolve Thumbnail
            let thumbnail = rawAsset.thumbnail;
            if (
              thumbnail &&
              !thumbnail.startsWith("http") &&
              !thumbnail.startsWith("blob:")
            ) {
              try {
                const thumbFile = await fileSystemService.readFile(thumbnail);
                thumbnail = URL.createObjectURL(thumbFile);
              } catch (e) {
                console.warn(`Failed to read thumbnail: ${thumbnail}`, e);
              }
            }

            // 3. Resolve Proxy
            let proxySrc = rawAsset.proxySrc;
            let proxyFile: Blob | undefined;
            if (
              proxySrc &&
              !proxySrc.startsWith("http") &&
              !proxySrc.startsWith("blob:")
            ) {
              try {
                const proxyBlob = await fileSystemService.readFile(proxySrc);
                proxyFile = proxyBlob;
                proxySrc = URL.createObjectURL(proxyBlob);
              } catch (e) {
                console.warn(`Failed to read proxy: ${proxySrc}`, e);
              }
            }

            const repairedDuration = await resolveAssetDurationRepair(
              rawAsset,
              fileObj,
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
              thumbnail,
              proxySrc,
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
          await projectDocumentService.updateProjectDocument((draft) => {
            if (!draft.assets) return;

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

      set({ assets: loadedAssets });
    } catch (err) {
      console.error("Failed to load assets from project.json", err);
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
  ) => {
    const [asset] = await get().addLocalAssets([file], creationMetadata);
    return asset ?? null;
  },

  addLocalAssets: async (
    files: readonly File[],
    creationMetadata?: Asset["creationMetadata"],
  ) => {
    const createdAssets: Asset[] = [];

    if (files.length === 0) {
      return createdAssets;
    }

    set((state) => ({
      uploadingCount: state.uploadingCount + 1,
      isUploading: true,
    }));

    try {
      const { assetService } = await import("./services/AssetService");
      const assets = [...get().assets];

      for (const file of files) {
        const newAsset = await assetService.ingestAsset(
          file,
          false,
          false,
          assets,
          creationMetadata,
        );

        if (!newAsset) {
          continue;
        }

        assets.push(newAsset);
        createdAssets.push(newAsset);
      }

      if (createdAssets.length > 0) {
        set((state) => ({
          assets: [...state.assets, ...createdAssets],
        }));
      }

      return createdAssets;
    } finally {
      set((state) => {
        const uploadingCount = Math.max(0, state.uploadingCount - 1);
        return {
          uploadingCount,
          isUploading: uploadingCount > 0,
        };
      });
    }
  },

  updateAsset: async (id: string, updates: Partial<Asset>) => {
    const previousAsset = get().assets.find((asset) => asset.id === id);
    if (!previousAsset) {
      return;
    }

    set((state) => ({
      assets: state.assets.map((a) => (a.id === id ? { ...a, ...updates } : a)),
    }));

    try {
      await projectDocumentService.updateProjectDocument((draft) => {
        if (!draft.assets?.[id]) {
          return;
        }

        Object.assign(draft.assets[id], updates);
      });
    } catch (error) {
      console.error(`Failed to persist asset update for '${id}'`, error);
      set((state) => ({
        assets: state.assets.map((asset) =>
          asset.id === id ? previousAsset : asset,
        ),
      }));
    }
  },

  getInput: async (assetId: string) => {
    const { assets, inputCache } = get();
    if (inputCache.has(assetId)) {
      return inputCache.get(assetId)!;
    }

    const asset = assets.find((a) => a.id === assetId);
    if (!asset) return null;

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

    // 1. Get asset details from project.json to find exact paths
    // We cannot rely solely on memory store because partial updates or Blob URLs might obscure original paths.
    let pathsToDelete: {
      src?: string;
      thumbnail?: string;
      proxySrc?: string;
    } = {};

    try {
      await projectDocumentService.updateProjectDocument((draft) => {
        if (!draft.assets || !draft.assets[id]) return;

        const storedAsset = draft.assets[id];
        pathsToDelete = {
          src: storedAsset.src,
          thumbnail: storedAsset.thumbnail,
          proxySrc: storedAsset.proxySrc,
        };

        delete draft.assets[id];
      });
    } catch (e) {
      console.error("Failed to update project.json during deletion", e);
      // If we can't read/write project.json, we might fail to get paths,
      // but we should still try to clean up memory.
    }

    // 2. Remove from memory immediately for UI responsiveness
    set((state) => ({
      assets: state.assets.filter((a) => a.id !== id),
    }));

    // 3. Delete files from disk using paths found in JSON
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
