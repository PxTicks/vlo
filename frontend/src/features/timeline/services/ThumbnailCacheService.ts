/**
 * ThumbnailCacheService
 *
 * A singleton service that manages shared thumbnail caches across clips.
 * Clips with the same assetId share the same cache, reducing memory usage
 * and avoiding redundant decoding.
 *
 * Features:
 * - Reference counting: Tracks how many clips use each asset's cache
 * - LRU eviction: Global 300MB memory limit with least-recently-used eviction
 * - O(1) operations: Uses Map + doubly-linked list for efficient access/eviction
 */

const MAX_CACHE_SIZE_BYTES = 300 * 1024 * 1024; // 300MB

// Doubly-linked list node for LRU tracking
interface LRUNode {
  assetId: string;
  key: string;
  sizeBytes: number;
  prev: LRUNode | null;
  next: LRUNode | null;
}

export interface ThumbnailAssetMetadata {
  aspectRatio: number;
  firstTimestampSeconds?: number;
}

interface AssetCacheEntry {
  metadata: ThumbnailAssetMetadata | null;
  thumbnails: Map<string, ImageBitmap>;
  lruNodes: Map<string, LRUNode>; // key -> LRU node for O(1) lookup
  refCount: number;
}

class ThumbnailCacheServiceClass {
  private caches = new Map<string, AssetCacheEntry>();

  // LRU doubly-linked list (head = most recent, tail = least recent)
  private lruHead: LRUNode | null = null;
  private lruTail: LRUNode | null = null;
  private currentSizeBytes = 0;

  /**
   * Acquire a reference to the cache for a given asset.
   * Creates a new cache if one doesn't exist, otherwise increments refCount.
   */
  acquire(assetId: string): AssetCacheEntry {
    let entry = this.caches.get(assetId);
    if (!entry) {
      entry = {
        metadata: null,
        thumbnails: new Map(),
        lruNodes: new Map(),
        refCount: 0,
      };
      this.caches.set(assetId, entry);
    }
    entry.refCount++;
    return entry;
  }

  /**
   * Release a reference to the cache for a given asset.
   * When refCount reaches 0, the cache is cleaned up.
   */
  release(assetId: string): void {
    const entry = this.caches.get(assetId);
    if (!entry) return;

    entry.refCount--;
    if (entry.refCount <= 0) {
      // Remove all LRU nodes for this asset
      entry.lruNodes.forEach((node) => {
        this.removeFromLRU(node);
        this.currentSizeBytes -= node.sizeBytes;
      });

      // Close all ImageBitmaps to free GPU memory
      entry.thumbnails.forEach((bitmap) => bitmap.close());
      entry.thumbnails.clear();
      entry.lruNodes.clear();
      this.caches.delete(assetId);
    }
  }

  /**
   * Get a thumbnail from the cache.
   * Promotes the entry to most-recently-used.
   */
  getThumbnail(assetId: string, key: string): ImageBitmap | undefined {
    const entry = this.caches.get(assetId);
    if (!entry) return undefined;

    const bitmap = entry.thumbnails.get(key);
    if (bitmap) {
      // Promote to head of LRU
      const node = entry.lruNodes.get(key);
      if (node) {
        this.promoteToHead(node);
      }
    }
    return bitmap;
  }

  /**
   * Check if a thumbnail exists in the cache.
   */
  hasThumbnail(assetId: string, key: string): boolean {
    return this.caches.get(assetId)?.thumbnails.has(key) ?? false;
  }

  /**
   * Store a thumbnail in the cache.
   * Evicts least-recently-used entries if the cache exceeds 300MB.
   */
  setThumbnail(assetId: string, key: string, bitmap: ImageBitmap): void {
    const entry = this.caches.get(assetId);
    if (!entry) return;

    // Calculate size: width * height * 4 bytes (RGBA)
    const sizeBytes = bitmap.width * bitmap.height * 4;

    // Check if this exact key already exists (update case)
    const existingNode = entry.lruNodes.get(key);
    if (existingNode) {
      // Close old bitmap and update size tracking
      const oldBitmap = entry.thumbnails.get(key);
      if (oldBitmap) {
        oldBitmap.close();
      }
      this.currentSizeBytes -= existingNode.sizeBytes;
      existingNode.sizeBytes = sizeBytes;
      this.currentSizeBytes += sizeBytes;
      this.promoteToHead(existingNode);
      entry.thumbnails.set(key, bitmap);
    } else {
      // New entry - evict if necessary
      this.evictIfNeeded(sizeBytes);

      // Create new LRU node
      const node: LRUNode = {
        assetId,
        key,
        sizeBytes,
        prev: null,
        next: null,
      };

      // Add to head of LRU
      this.addToHead(node);
      entry.lruNodes.set(key, node);
      entry.thumbnails.set(key, bitmap);
      this.currentSizeBytes += sizeBytes;
    }
  }

  /**
   * Get metadata (aspect ratio) for an asset.
   */
  getMetadata(assetId: string): ThumbnailAssetMetadata | null {
    return this.caches.get(assetId)?.metadata ?? null;
  }

  /**
   * Set metadata (aspect ratio) for an asset.
   */
  setMetadata(assetId: string, metadata: ThumbnailAssetMetadata): void {
    const entry = this.caches.get(assetId);
    if (entry) {
      entry.metadata = metadata;
    }
  }

  /**
   * Get the entire thumbnails map for iteration (read-only access pattern).
   * Note: This does NOT update LRU status for performance reasons.
   */
  getThumbnailsMap(assetId: string): Map<string, ImageBitmap> | undefined {
    return this.caches.get(assetId)?.thumbnails;
  }

  /**
   * Clear all caches. Useful for testing or app reset.
   */
  clearAll(): void {
    this.caches.forEach((entry) => {
      entry.thumbnails.forEach((bitmap) => bitmap.close());
      entry.thumbnails.clear();
      entry.lruNodes.clear();
    });
    this.caches.clear();
    this.lruHead = null;
    this.lruTail = null;
    this.currentSizeBytes = 0;
  }

  /**
   * Get current reference count for an asset (useful for debugging/testing).
   */
  getRefCount(assetId: string): number {
    return this.caches.get(assetId)?.refCount ?? 0;
  }

  /**
   * Get current cache size in bytes (useful for debugging/testing).
   */
  getCurrentSizeBytes(): number {
    return this.currentSizeBytes;
  }

  /**
   * Get max cache size in bytes.
   */
  getMaxSizeBytes(): number {
    return MAX_CACHE_SIZE_BYTES;
  }

  // --- Private LRU helpers ---

  private addToHead(node: LRUNode): void {
    node.prev = null;
    node.next = this.lruHead;
    if (this.lruHead) {
      this.lruHead.prev = node;
    }
    this.lruHead = node;
    if (!this.lruTail) {
      this.lruTail = node;
    }
  }

  private removeFromLRU(node: LRUNode): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.lruHead = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.lruTail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  private promoteToHead(node: LRUNode): void {
    if (node === this.lruHead) return; // Already at head
    this.removeFromLRU(node);
    this.addToHead(node);
  }

  private evictIfNeeded(incomingSizeBytes: number): void {
    // Evict from tail until we have room for the incoming entry
    while (
      this.lruTail &&
      this.currentSizeBytes + incomingSizeBytes > MAX_CACHE_SIZE_BYTES
    ) {
      const nodeToEvict = this.lruTail;
      const entry = this.caches.get(nodeToEvict.assetId);

      if (entry) {
        // Close the bitmap
        const bitmap = entry.thumbnails.get(nodeToEvict.key);
        if (bitmap) {
          bitmap.close();
        }
        entry.thumbnails.delete(nodeToEvict.key);
        entry.lruNodes.delete(nodeToEvict.key);
      }

      this.currentSizeBytes -= nodeToEvict.sizeBytes;
      this.removeFromLRU(nodeToEvict);
    }
  }
}

// Export singleton instance
export const thumbnailCacheService = new ThumbnailCacheServiceClass();
