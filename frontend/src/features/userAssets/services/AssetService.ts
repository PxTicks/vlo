import type { Asset } from "../../../types/Asset";
import { fileSystemService } from "../../project";
import { projectDocumentService } from "../../project/services/ProjectDocumentService";
import { mediaProcessingService } from "./MediaProcessingService";

export class AssetService {
  /**
   * Scans the project root for new assets, ingests them, and persists them to project.json.
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
        const newAsset = await this.ingestAsset(
          file,
          true,
          true,
          existingAssets,
        );
        if (newAsset) {
          newAssetsToPersist.push(newAsset);
          existingAssets.push(newAsset); // Add to local check too so we don't add duplicates if logic fails
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
        `[Scanner] Persisting ${newAssetsToPersist.length} new assets to project.json`,
      );
      try {
        await projectDocumentService.updateProjectDocument((draft) => {
          if (!draft.assets) draft.assets = {};

          for (const asset of newAssetsToPersist) {
            // Convert in-memory asset (blob URLs) to persisted asset (file paths)
            const persistedAsset = this.toPersisted(asset);
            draft.assets[asset.id] = persistedAsset;
          }
        });
        console.log("[Scanner] Project updated successfully.");
      } catch (e) {
        console.error("[Scanner] Failed to batch save project.json", e);
      }
    } else {
      console.log("[Scanner] No new assets to persist.");
    }

    return newAssetsToPersist;
  }

  /**
   * Converts an in-memory asset (with blob URLs) to a persisted asset (with file paths).
   * This is needed when batch-saving assets during scanning.
   */
  private toPersisted(asset: Asset): Asset {
    const persistedAsset: Asset = {
      ...asset,
      // Remove blob URLs and use file paths
      src: asset.name, // Main source is stored at project root
      thumbnail: asset.thumbnail
        ? `.vloproject/thumbnails/${asset.name}_thumb.webp`
        : undefined,
      proxySrc: asset.proxySrc
        ? `.vloproject/proxies/${asset.name}_proxy.mp4`
        : undefined,
      // Remove runtime-only properties
      file: undefined,
      proxyFile: undefined,
    };
    return persistedAsset;
  }

  /**
   * Internal ingest logic.
   * Returns the new Asset if successful, or null.
   */
  async ingestAsset(
    file: File,
    skipFileSave: boolean,
    skipProjectSave: boolean,
    existingAssets: Asset[],
    creationMetadata?: Asset["creationMetadata"],
  ): Promise<Asset | null> {
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

      // Sanitize first to check against existing sanitized names
      const safeName = mediaProcessingService.sanitizeFilename(file.name);

      // Re-check duplications (double safety)
      if (existingAssets.some((a) => a.name === safeName)) {
        console.log(`[Ingest] Skipping duplicate asset by name: ${safeName}`);
        return null; // Finally block will dispose
      }

      const assetId = crypto.randomUUID();
      const isImage = file.type.startsWith("image/");
      const isAudio = file.type.startsWith("audio/");
      const isVideo = file.type.startsWith("video/");

      // Only process supported types
      if (!isImage && !isAudio && !isVideo) {
        console.warn("Skipping unsupported file type:", file.name, file.type);
        return null; // Finally block will dispose
      }

      const hash = await mediaProcessingService.computeChecksum(file);

      // Hash check
      if (existingAssets.some((a) => a.hash === hash)) {
        console.log("Skipping duplicate asset (hash match):", file.name);
        return null; // Finally block will dispose
      }

      // 3. Prepare Paths variables
      const assetFileName = safeName;
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
          const thumbName = `${safeName}_thumb.webp`;
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
          const thumbName = `${safeName}_thumb.webp`;
          storageThumbnail = `.vloproject/thumbnails/${thumbName}`;
        }

        // Generate proxy
        console.log(`[Ingest] Generating proxy for ${file.name}...`);
        console.time(`[Ingest] Proxy Generation ${file.name}`);
        try {
          proxyBlob = await processor.generateProxyVideo();
          if (proxyBlob) {
            storageProxy = `.vloproject/proxies/${safeName}_proxy.mp4`;
          }
        } catch (e) {
          console.warn(`[Ingest] Proxy generation failed for ${file.name}`, e);
        }
        console.timeEnd(`[Ingest] Proxy Generation ${file.name}`);
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

      // 5. Construct In-Memory Asset (Return this immediately)
      console.time(`[Ingest] Object Creation ${file.name}`);
      const newAssetInMemory: Asset = {
        id: assetId,
        hash: hash,
        name: assetFileName,
        type: isImage ? "image" : isAudio ? "audio" : "video",
        src: URL.createObjectURL(file),
        thumbnail: thumbnailBlob
          ? URL.createObjectURL(thumbnailBlob)
          : undefined,
        proxySrc: proxyBlob // Use the blob directly!
          ? URL.createObjectURL(proxyBlob)
          : undefined,
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
        ...newAssetInMemory,
        src: storageSrc,
        thumbnail: storageThumbnail,
        proxySrc: storageProxy,
        file: undefined,
      };
      console.timeEnd(`[Ingest] Object Creation ${file.name}`);

      // 7. Fire-and-Forget (Background) Persistence
      (async () => {
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
            const proxyFile = new File([proxyBlob], `${safeName}_proxy.mp4`, {
              type: "video/mp4",
            });
            await fileSystemService.saveAssetFile(proxyFile, storageProxy);
            console.timeEnd(`[Ingest-BG] Save Proxy ${file.name}`);
          }

          // Save Project JSON
          if (!skipProjectSave) {
            console.time(`[Ingest-BG] Project Save ${file.name}`);
            await projectDocumentService.updateProjectDocument((draft) => {
              if (!draft.assets) draft.assets = {};
              draft.assets[assetId] = newAssetPersisted;
            });
            console.timeEnd(`[Ingest-BG] Project Save ${file.name}`);
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
        }
      })();

      console.timeEnd(`[Ingest] ${file.name}`);
      return newAssetInMemory; // Return immediately!
    } catch (e) {
      console.error("Failed to ingest asset", e);
      console.timeEnd(`[Ingest] ${file.name}`);
      return null;
    } finally {
      processor.dispose();
    }
  }
}

export const assetService = new AssetService();
