# User Assets Feature

The `userAssets` feature manages the ingestion, processing, storage, and retrieval of user-provided media files (Video, Audio, Images) within the VLO editor.

## Architecture

This feature follows a **Store-Service-Utility** architecture to separate concerns:

1.  **State Management (`useAssetStore`)**: Holds the reactive state (list of assets, loading flags) and provides the API for UI components.
2.  **Business Logic (`AssetService`)**: Orchestrates complex workflows like file scanning, renaming collision checks, and persistence.
3.  **Data Processing (`MediaProcessingService`)**: Handles low-level operations like checksum calculation, MIME checking, and thumbnail generation.
4.  **File System**: Direct interaction with the `fileSystemService` project module to read/write files and `project.json`.

---

## Data Model

### `Asset`

Defined in `src/types/Asset.ts`.

```typescript
interface Asset {
  id: string; // UUID
  hash: string; // xxhash64 checksum for deduplication
  name: string; // Filename on disk (e.g., "video.mp4")
  type: "video" | "image" | "audio";
  src: string; // Blob URL (run-time) or Path (storage)
  thumbnail?: string; // Blob URL or Path
  duration?: number; // In seconds
  file?: File; // Optional reference to the raw File object (memory only)
  createdAt: number;
}
```

---

## Key Components & Access

### 1. Asset Store (`useAssetStore`)

**Access:** `import { useAssetStore } from "./useAssetStore";`

The primary interface for UI components.

- **`assets`**: `Asset[]` - The list of currently loaded assets.
- **`addLocalAsset(file: File)`**: Ingests a single file (e.g., from drag-and-drop). Generates metadata, saves to disk, and updates state.
- **`scanForNewAssets()`**: Scans the project directory for untracked files and ingests them. useful for when files are added manually to the folder.
- **`deleteAsset(id)`**: Removes the asset from state, `project.json`, and deletes the file from disk.
- **`getInput(assetId)`**: Returns a cached `mediabunny.Input` instance for playback/rendering.

### 2. Asset Service (`AssetService`)

**Access:** Internal use mainly (via Store).

Encapsulates "heavy" operations to keep the store clean.

- **`ingestAsset(...)`**: The core pipeline:
  1.  **MIME Detection**: Uses magic bytes to identify file types even if extensions are missing/wrong.
  2.  **Sanitization**: Renames files to be FS-safe (e.g., `my image.png` -> `my_image.png`).
  3.  **Deduplication**: Checks both filename and content hash vs existing assets.
  4.  **Processing**: Generates thumbnails and video duration.
  5.  **Persistence**: Writes to `project.json` and optionally saves the file to disk.

### 3. Asset Processing Service (`MediaProcessingService`)

**Access:** Internal use.

Stateless utilities for media data.

- `computeChecksum(file)`: xxhash64.
- `detectMimeType(file)`: Magic byte inference for common media types.
- `generateVideoMetadata(file)`: Extracts duration and frame thumbnail using `mediabunny`.
- `generateImageThumbnail(file)`: Resizes images to max 320x320 using `OffscreenCanvas`.

---

## Persistence

Assets are persisted in two places:

1.  **Files**: The actual media files are stored in the project root.
2.  **Metadata**: Stored in `.vloproject/project.json` under the `assets` key.
3.  **Thumbnails**: Stored in `.vloproject/thumbnails/`.

The `AssetService` ensures that the JSON registry stays in sync with the file system during ingestion and deletion.
