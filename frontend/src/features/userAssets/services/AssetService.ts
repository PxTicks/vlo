import type {
  Asset,
  AssetFamily,
  AssetFamilyCompatibility,
} from "../../../types/Asset";
import {
  doesAssetMatchFamilyCompatibility,
  isAssetFamilyCompatibilityComplete,
} from "../../../shared/utils/assetFamilies";
import { fileSystemService, projectPersistenceService } from "../../project";
import { mediaProcessingService } from "./MediaProcessingService";

const assetPersistencePromises = new Map<string, Promise<void>>();

export type AssetIngestResult =
  | {
      status: "created";
      asset: Asset;
    }
  | {
      status: "reused_existing";
      asset: Asset;
      reason: "hash";
    }
  | {
      status: "skipped_existing";
      reason: "hash";
    }
  | {
      status: "skipped";
      reason: "unsupported" | "failed";
    };

export interface AssetIngestOptions {
  allowDuplicateHash?: boolean;
}

function splitFilename(filename: string): { stem: string; extension: string } {
  const extensionIndex = filename.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return {
      stem: filename,
      extension: "",
    };
  }

  return {
    stem: filename.slice(0, extensionIndex),
    extension: filename.slice(extensionIndex),
  };
}

function resolveUniqueAssetFilename(
  filename: string,
  existingAssets: readonly Asset[],
): string {
  const takenNames = new Set(existingAssets.map((asset) => asset.name));
  if (!takenNames.has(filename)) {
    return filename;
  }

  const { stem, extension } = splitFilename(filename);
  let suffix = 2;

  while (true) {
    const candidate = `${stem}_${suffix}${extension}`;
    if (!takenNames.has(candidate)) {
      return candidate;
    }
    suffix += 1;
  }
}

export class AssetService {
  async waitForAssetPersistence(assetId: string): Promise<void> {
    const persistencePromise = assetPersistencePromises.get(assetId);
    if (!persistencePromise) {
      return;
    }

    try {
      await persistencePromise;
    } finally {
      assetPersistencePromises.delete(assetId);
    }
  }

  async waitForAssetsPersistence(assetIds: readonly string[]): Promise<void> {
    const uniqueAssetIds = [...new Set(assetIds.filter(Boolean))];
    await Promise.all(
      uniqueAssetIds.map((assetId) => this.waitForAssetPersistence(assetId)),
    );
  }

  async waitForAllAssetPersistence(): Promise<void> {
    const assetIds = [...assetPersistencePromises.keys()];
    await this.waitForAssetsPersistence(assetIds);
  }

  /**
   * Scans the project root for new assets, ingests them, and persists them to assets.json.
   * Returns a list of the newly added assets.
   */
  async scanForNewAssets(existingAssets: Asset[]): Promise<Asset[]> {
    console.log("[Scanner] Starting scan...");

    // Deduplication Set
    const knownPaths = new Set(existingAssets.map((a) => a.name));
    console.log("[Scanner] Known assets:", Array.from(knownPaths));

    // List root directory
    let files: string[] = [];
    try {
      files = await fileSystemService.listDirectory(".");
    } catch (e) {
      console.error("Failed to list directory", e);
      return [];
    }

    console.log("[Scanner] Files found on disk:", files);

    const newAssetsToPersist: Asset[] = [];
    const processedNames = new Set<string>(); // Prevent double-processing in single loop

    for (const filename of files) {
      // Skip .vloproject folder and other dotfiles
      if (filename.startsWith(".")) continue;

      if (processedNames.has(filename)) continue;
      processedNames.add(filename);

      // Sanitize filename to check against store
      const safeName = mediaProcessingService.sanitizeFilename(filename);

      // Check if we need to rename on disk
      let actualFilenameToProcess = filename;

      if (filename !== safeName) {
        console.log(
          `[Scanner] Found Unsanitized Filename: '${filename}' -> Renaming to '${safeName}'`,
        );
        try {
          // Check if the target safe name already exists on disk?
          // If "my_image.png" already exists, we might have a collision.
          // For now, we assume if we rename, we want to process the *new* name.

          await fileSystemService.renameFile(filename, safeName);
          actualFilenameToProcess = safeName;
        } catch (renameErr) {
          console.error(
            `[Scanner] Failed to rename ${filename} to ${safeName}`,
            renameErr,
          );
          // Fallback: try to process original, but it might fail ingest if we rely on matching names
        }
      }

      if (knownPaths.has(safeName)) {
        console.log(
          `[Scanner] Skipping known file (by sanitized name): ${actualFilenameToProcess}`,
        );
        continue;
      }

      console.log(`[Scanner] Processing new file: ${actualFilenameToProcess}`);
      try {
        const file = await fileSystemService.readFile(actualFilenameToProcess);

        // Ingest without saving the file (already on disk, just renamed if needed)
        // AND without saving project (we batch it)
        const ingestResult = await this.ingestAssetWithResult(
          file,
          true,
          true,
          existingAssets,
        );
        if (ingestResult.status === "created") {
          newAssetsToPersist.push(ingestResult.asset);
          existingAssets.push(ingestResult.asset); // Add to local check too so we don't add duplicates if logic fails
        }
      } catch (e) {
        console.warn(
          `Failed to process scanned file: ${actualFilenameToProcess}`,
          e,
        );
      }
    }

    // Batch Persist to JSON
    if (newAssetsToPersist.length > 0) {
      console.log(
        `[Scanner] Persisting ${newAssetsToPersist.length} new assets to assets.json`,
      );
      try {
        await projectPersistenceService.persistAssetEntries(newAssetsToPersist);
        console.log("[Scanner] Project updated successfully.");
      } catch (e) {
        console.error("[Scanner] Failed to batch save assets.json", e);
      }
    } else {
      console.log("[Scanner] No new assets to persist.");
    }

    return newAssetsToPersist;
  }

  /**
   * Internal ingest logic.
   * Returns the new Asset if successful, or null.
   */
  async ingestAssetWithResult(
    file: File,
    skipFileSave: boolean,
    skipProjectSave: boolean,
    existingAssets: Asset[],
    creationMetadata?: Asset["creationMetadata"],
    family?: Pick<AssetFamily, "id" | "compatibility">,
    compatibilityHint?: AssetFamilyCompatibility | null,
    options: AssetIngestOptions = {},
  ): Promise<AssetIngestResult> {
    console.time(`[Ingest] ${file.name}`);
    // Use MediaFileProcessor for optimized access to the file
    const processor = mediaProcessingService.createProcessor(file);

    try {
      // Fix missing or generic MIME type (Shared logic for Scan & Upload)
      if (
        !file.type ||
        file.type === "application/octet-stream" ||
        file.type === "text/plain"
      ) {
        let inferredType = "";

        console.log(
          `[Ingest] Checking content (magic bytes) for ${file.name}...`,
        );
        try {
          const detected = await processor.detectMimeType();
          if (detected) inferredType = detected;
        } catch (err) {
          console.warn("[Ingest] Magic byte detection failed", err);
        }

        if (inferredType) {
          console.log(
            `[Ingest] Inferred type for ${file.name}: ${inferredType}`,
          );
          file = new File([file], file.name, { type: inferredType });
        }
      }

      // Sanitize first so the on-disk filename is always safe.
      const safeName = mediaProcessingService.sanitizeFilename(file.name);

      const assetId = crypto.randomUUID();
      const isImage = file.type.startsWith("image/");
      const isAudio = file.type.startsWith("audio/");
      const isVideo = file.type.startsWith("video/");

      // Only process supported types
      if (!isImage && !isAudio && !isVideo) {
        console.warn("Skipping unsupported file type:", file.name, file.type);
        return {
          status: "skipped",
          reason: "unsupported",
        };
      }

      const hash = await mediaProcessingService.computeChecksum(file);

      const isIncomingMask = creationMetadata?.source === "generation_mask";
      const matchingAsset = existingAssets.find((a) => a.hash === hash);

      if (matchingAsset && !options.allowDuplicateHash) {
        // Generation masks frequently produce identical bytes across runs (same
        // source + mask + crop). Reuse the existing mask asset so multiple
        // generated outputs can share one mask record via generationMaskAssetId.
        if (
          isIncomingMask &&
          matchingAsset.creationMetadata?.source === "generation_mask"
        ) {
          return {
            status: "reused_existing",
            asset: matchingAsset,
            reason: "hash",
          };
        }

        if (!isIncomingMask) {
          console.log("Skipping duplicate asset (hash match):", file.name);
          return {
            status: "skipped_existing",
            reason: "hash",
          };
        }

        // Incoming mask, but the hash match is a non-mask asset — fall through
        // to create a fresh mask record so the asset linkage stays well-typed.
      }

      const assetFileName = resolveUniqueAssetFilename(safeName, existingAssets);
      if (assetFileName !== safeName) {
        console.log(
          `[Ingest] Resolved asset name collision: '${safeName}' -> '${assetFileName}'`,
        );
      }

      // 3. Prepare Paths variables
      const storageSrc = assetFileName;
      let storageThumbnail: string | undefined;
      let storageProxy: string | undefined;
      let proxyBlob: Blob | null = null;

      // 4. Generate Metadata / Proxy (CPU Bound - keep awaited)
      let duration = isImage ? 5 : 0;
      let fps: number | undefined;
      let thumbnailBlob: Blob | null = null;

      if (isImage) {
        thumbnailBlob =
          await mediaProcessingService.generateImageThumbnail(file);
        if (thumbnailBlob) {
          const thumbName = `${assetFileName}_thumb.webp`;
          storageThumbnail = `.vloproject/thumbnails/${thumbName}`;
        }
      } else if (isVideo) {
        const metadata = await processor.generateVideoMetadata();
        duration = metadata.duration;
        fps =
          typeof metadata.fps === "number" && metadata.fps > 0
            ? metadata.fps
            : undefined;
        thumbnailBlob = metadata.thumbnail;
        if (thumbnailBlob) {
          const thumbName = `${assetFileName}_thumb.webp`;
          storageThumbnail = `.vloproject/thumbnails/${thumbName}`;
        }

        // Generate proxy
        console.log(`[Ingest] Generating proxy for ${file.name}...`);
        console.time(`[Ingest] Proxy Generation ${file.name}`);
        try {
          proxyBlob = await processor.generateProxyVideo();
          if (proxyBlob) {
            storageProxy = `.vloproject/proxies/${assetFileName}_proxy.mp4`;
          }
        } catch (e) {
          console.warn(`[Ingest] Proxy generation failed for ${file.name}`, e);
        }
        console.timeEnd(`[Ingest] Proxy Generation ${file.name}`);
      } else if (isAudio) {
        duration = await processor.computeDuration();
      }

      // Check for audio track if it's a video or audio file
      let hasAudio = false;
      if (isVideo || isAudio) {
        // for audio files it is trivially true, but let's check properly via mediabunny ?
        // Actually for audio files `file.type.startsWith('audio/')` implies hasAudio.
        // But for video files we need to check.
        if (isAudio) {
          hasAudio = true;
        } else if (isVideo) {
          hasAudio = await processor.hasAudioTrack();
        }
      }

      const assetType = isImage ? "image" : isAudio ? "audio" : "video";
      const resolvedCompatibilityHint =
        compatibilityHint &&
        isAssetFamilyCompatibilityComplete(compatibilityHint) &&
        compatibilityHint.assetType === assetType
          ? compatibilityHint
          : null;
      if (resolvedCompatibilityHint) {
        duration = resolvedCompatibilityHint.durationMs! / 1000;
        fps =
          resolvedCompatibilityHint.assetType === "video"
            ? resolvedCompatibilityHint.fpsMilli! / 1000
            : undefined;
      }

      const resolvedFamilyId =
        family &&
        doesAssetMatchFamilyCompatibility(
          {
            type: assetType,
            duration,
            fps,
          },
          family.compatibility,
        )
          ? family.id
          : undefined;

      if (family && !resolvedFamilyId) {
        console.warn(
          `[Ingest] Skipping family assignment for ${file.name} because it does not match family '${family.id}' compatibility.`,
        );
      }

      // 5. Construct In-Memory Asset (Return this immediately)
      console.time(`[Ingest] Object Creation ${file.name}`);
      const newAssetInMemory: Asset = {
        id: assetId,
        hash: hash,
        familyId: resolvedFamilyId,
        name: assetFileName,
        type: assetType,
        src: URL.createObjectURL(file),
        sourcePath: storageSrc,
        thumbnail: thumbnailBlob
          ? URL.createObjectURL(thumbnailBlob)
          : undefined,
        thumbnailPath: storageThumbnail,
        proxySrc: proxyBlob // Use the blob directly!
          ? URL.createObjectURL(proxyBlob)
          : undefined,
        proxyPath: storageProxy,
        proxyFile: proxyBlob || undefined,
        duration: duration,
        fps,
        hasAudio: hasAudio,
        createdAt: Date.now(),
        file: file,
        creationMetadata: creationMetadata,
      };

      // 6. Define Persistence Object
      const newAssetPersisted: Asset = {
        id: newAssetInMemory.id,
        hash: newAssetInMemory.hash,
        familyId: newAssetInMemory.familyId,
        name: newAssetInMemory.name,
        type: newAssetInMemory.type,
        favourite: newAssetInMemory.favourite,
        src: storageSrc,
        thumbnail: storageThumbnail,
        proxySrc: storageProxy,
        duration: newAssetInMemory.duration,
        fps: newAssetInMemory.fps,
        hasAudio: newAssetInMemory.hasAudio,
        createdAt: newAssetInMemory.createdAt,
        creationMetadata: newAssetInMemory.creationMetadata,
      };
      console.timeEnd(`[Ingest] Object Creation ${file.name}`);

      // 7. Fire-and-Forget (Background) Persistence
      const persistencePromise = (async () => {
        try {
          console.log(
            `[Ingest-BG] Starting background writes for ${file.name}`,
          );

          // Save Source
          if (!skipFileSave) {
            await fileSystemService.saveAssetFile(file, storageSrc);
          }

          // Save Thumbnail
          if (thumbnailBlob && storageThumbnail) {
            console.time(`[Ingest-BG] Save Thumbnail ${file.name}`);
            await fileSystemService.saveAssetFile(
              thumbnailBlob as File,
              storageThumbnail,
            );
            console.timeEnd(`[Ingest-BG] Save Thumbnail ${file.name}`);
          }

          // Save Proxy
          if (proxyBlob && storageProxy) {
            console.time(`[Ingest-BG] Save Proxy ${file.name}`);
            const proxyFile = new File([proxyBlob], `${assetFileName}_proxy.mp4`, {
              type: "video/mp4",
            });
            await fileSystemService.saveAssetFile(proxyFile, storageProxy);
            console.timeEnd(`[Ingest-BG] Save Proxy ${file.name}`);
          }

          // Save Project JSON
          if (!skipProjectSave) {
            console.time(`[Ingest-BG] Asset Index Save ${file.name}`);
            await projectPersistenceService.persistAssetEntry(newAssetPersisted);
            console.timeEnd(`[Ingest-BG] Asset Index Save ${file.name}`);
          }

          console.log(`[Ingest-BG] All writes complete for ${file.name}`);
        } catch (e) {
          console.error(
            `[Ingest-BG] Failed to persist asset ${file.name}`,
            e,
            {
              storageSrc,
              storageThumbnail,
              storageProxy,
            },
          );
          // Note: Silent failure here means app assumes asset is safe but it's not on disk.
          // In a perfect world we'd update a 'sync status' store.
          throw e;
        }
      })();
      assetPersistencePromises.set(assetId, persistencePromise);
      void persistencePromise.catch(() => {});

      console.timeEnd(`[Ingest] ${file.name}`);
      return {
        status: "created",
        asset: newAssetInMemory,
      };
    } catch (e) {
      console.error("Failed to ingest asset", e);
      console.timeEnd(`[Ingest] ${file.name}`);
      return {
        status: "skipped",
        reason: "failed",
      };
    } finally {
      processor.dispose();
    }
  }

  async ingestAsset(
    file: File,
    skipFileSave: boolean,
    skipProjectSave: boolean,
    existingAssets: Asset[],
    creationMetadata?: Asset["creationMetadata"],
    family?: Pick<AssetFamily, "id" | "compatibility">,
    compatibilityHint?: AssetFamilyCompatibility | null,
    options: AssetIngestOptions = {},
  ): Promise<Asset | null> {
    const result = await this.ingestAssetWithResult(
      file,
      skipFileSave,
      skipProjectSave,
      existingAssets,
      creationMetadata,
      family,
      compatibilityHint,
      options,
    );

    return result.status === "created" ? result.asset : null;
  }
}

export const assetService = new AssetService();
