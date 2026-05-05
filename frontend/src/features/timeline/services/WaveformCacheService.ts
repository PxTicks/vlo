const MAX_CACHE_SIZE_BYTES = 64 * 1024 * 1024;

export const WAVEFORM_BASE_SAMPLES_PER_PEAK = 128;
export const WAVEFORM_PEAKS_PER_BUCKET = 256;

interface LRUNode {
  assetId: string;
  key: string;
  sizeBytes: number;
  prev: LRUNode | null;
  next: LRUNode | null;
}

export interface WaveformAssetMetadata {
  sampleRate: number;
  numberOfChannels: number;
  durationSeconds: number;
  firstTimestampSeconds?: number;
  baseSamplesPerPeak: number;
  peaksPerBucket: number;
}

interface AssetCacheEntry {
  buckets: Map<string, Int16Array>;
  lruNodes: Map<string, LRUNode>;
  metadata: WaveformAssetMetadata | null;
  refCount: number;
}

export interface ClosestWaveformBucketMatch {
  bucket: Int16Array;
  bucketIndex: number;
  level: number;
  peakIndex: number;
}

class WaveformCacheServiceClass {
  private caches = new Map<string, AssetCacheEntry>();
  private currentSizeBytes = 0;
  private lruHead: LRUNode | null = null;
  private lruTail: LRUNode | null = null;

  acquire(assetId: string): AssetCacheEntry {
    let entry = this.caches.get(assetId);
    if (!entry) {
      entry = {
        buckets: new Map(),
        lruNodes: new Map(),
        metadata: null,
        refCount: 0,
      };
      this.caches.set(assetId, entry);
    }
    entry.refCount++;
    return entry;
  }

  release(assetId: string): void {
    const entry = this.caches.get(assetId);
    if (!entry) {
      return;
    }

    entry.refCount--;
    if (entry.refCount > 0) {
      return;
    }

    entry.lruNodes.forEach((node) => {
      this.removeFromLRU(node);
      this.currentSizeBytes -= node.sizeBytes;
    });

    entry.buckets.clear();
    entry.lruNodes.clear();
    this.caches.delete(assetId);
  }

  getMetadata(assetId: string): WaveformAssetMetadata | null {
    return this.caches.get(assetId)?.metadata ?? null;
  }

  setMetadata(assetId: string, metadata: WaveformAssetMetadata): void {
    const entry = this.caches.get(assetId);
    if (entry) {
      entry.metadata = metadata;
    }
  }

  getBucket(assetId: string, level: number, index: number): Int16Array | undefined {
    const entry = this.caches.get(assetId);
    if (!entry) {
      return undefined;
    }

    const key = this.getBucketKey(level, index);
    const bucket = entry.buckets.get(key);
    if (bucket) {
      const node = entry.lruNodes.get(key);
      if (node) {
        this.promoteToHead(node);
      }
    }
    return bucket;
  }

  hasBucket(assetId: string, level: number, index: number): boolean {
    return this.caches.get(assetId)?.buckets.has(this.getBucketKey(level, index)) ?? false;
  }

  hasAnyBuckets(assetId: string): boolean {
    return (this.caches.get(assetId)?.buckets.size ?? 0) > 0;
  }

  getBucketCount(assetId: string): number {
    return this.caches.get(assetId)?.buckets.size ?? 0;
  }

  setBucket(assetId: string, level: number, index: number, bucket: Int16Array): void {
    const entry = this.caches.get(assetId);
    if (!entry) {
      return;
    }

    this.setBucketInternal(entry, assetId, level, index, bucket);
    this.deriveAncestorBuckets(entry, assetId, level, index);
  }

  findClosestBucket(
    assetId: string,
    targetLevel: number,
    targetPeakIndex: number,
  ): ClosestWaveformBucketMatch | null {
    const entry = this.caches.get(assetId);
    const metadata = entry?.metadata;
    if (!entry || !metadata) {
      return null;
    }

    const totalFrames = Math.max(
      0,
      Math.ceil(metadata.durationSeconds * metadata.sampleRate),
    );
    if (totalFrames <= 0) {
      return null;
    }

    for (let searchLevel = targetLevel; searchLevel < targetLevel + 32; searchLevel++) {
      const scale = 2 ** (searchLevel - targetLevel);
      const searchPeakIndex = Math.floor(targetPeakIndex / scale);
      const bucketIndex = Math.floor(searchPeakIndex / metadata.peaksPerBucket);
      const peakIndex = searchPeakIndex % metadata.peaksPerBucket;
      const bucket = this.getBucket(assetId, searchLevel, bucketIndex);

      if (bucket) {
        return { bucket, bucketIndex, level: searchLevel, peakIndex };
      }

      const framesPerPeak = metadata.baseSamplesPerPeak * 2 ** searchLevel;
      if (framesPerPeak >= totalFrames && searchPeakIndex === 0) {
        break;
      }
    }

    return null;
  }

  clearAll(): void {
    this.caches.forEach((entry) => {
      entry.buckets.clear();
      entry.lruNodes.clear();
    });
    this.caches.clear();
    this.currentSizeBytes = 0;
    this.lruHead = null;
    this.lruTail = null;
  }

  getCurrentSizeBytes(): number {
    return this.currentSizeBytes;
  }

  getMaxSizeBytes(): number {
    return MAX_CACHE_SIZE_BYTES;
  }

  getRefCount(assetId: string): number {
    return this.caches.get(assetId)?.refCount ?? 0;
  }

  private getBucketKey(level: number, index: number): string {
    return `${level}_${index}`;
  }

  private setBucketInternal(
    entry: AssetCacheEntry,
    assetId: string,
    level: number,
    index: number,
    bucket: Int16Array,
  ): void {
    const key = this.getBucketKey(level, index);
    const sizeBytes = bucket.byteLength;
    const existingNode = entry.lruNodes.get(key);

    if (existingNode) {
      this.currentSizeBytes -= existingNode.sizeBytes;
      existingNode.sizeBytes = sizeBytes;
      this.currentSizeBytes += sizeBytes;
      this.promoteToHead(existingNode);
      entry.buckets.set(key, bucket);
      return;
    }

    this.evictIfNeeded(sizeBytes);

    const node: LRUNode = {
      assetId,
      key,
      sizeBytes,
      prev: null,
      next: null,
    };

    this.addToHead(node);
    entry.buckets.set(key, bucket);
    entry.lruNodes.set(key, node);
    this.currentSizeBytes += sizeBytes;
  }

  private deriveAncestorBuckets(
    entry: AssetCacheEntry,
    assetId: string,
    level: number,
    index: number,
  ): void {
    let childLevel = level;
    let childIndex = index;

    while (true) {
      const parentLevel = childLevel + 1;
      const parentIndex = Math.floor(childIndex / 2);
      const leftIndex = parentIndex * 2;
      const rightIndex = leftIndex + 1;
      const leftBucket = entry.buckets.get(this.getBucketKey(childLevel, leftIndex));
      const rightBucket = entry.buckets.get(this.getBucketKey(childLevel, rightIndex));

      if (!leftBucket || !rightBucket) {
        return;
      }

      const parentBucket = new Int16Array(WAVEFORM_PEAKS_PER_BUCKET * 2);
      for (let peakIndex = 0; peakIndex < WAVEFORM_PEAKS_PER_BUCKET; peakIndex++) {
        const childBucket =
          peakIndex < WAVEFORM_PEAKS_PER_BUCKET / 2 ? leftBucket : rightBucket;
        const childPeakBaseIndex =
          peakIndex < WAVEFORM_PEAKS_PER_BUCKET / 2
            ? peakIndex * 2
            : (peakIndex - WAVEFORM_PEAKS_PER_BUCKET / 2) * 2;
        const childPeakOffset = childPeakBaseIndex * 2;
        const pairMin = childBucket[childPeakOffset];
        const pairMax = childBucket[childPeakOffset + 1];
        const nextPairMin = childBucket[childPeakOffset + 2];
        const nextPairMax = childBucket[childPeakOffset + 3];
        const parentOffset = peakIndex * 2;

        parentBucket[parentOffset] = Math.min(pairMin, nextPairMin);
        parentBucket[parentOffset + 1] = Math.max(pairMax, nextPairMax);
      }

      this.setBucketInternal(entry, assetId, parentLevel, parentIndex, parentBucket);
      childLevel = parentLevel;
      childIndex = parentIndex;
    }
  }

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
    if (node === this.lruHead) {
      return;
    }

    this.removeFromLRU(node);
    this.addToHead(node);
  }

  private evictIfNeeded(incomingSizeBytes: number): void {
    while (
      this.lruTail &&
      this.currentSizeBytes + incomingSizeBytes > MAX_CACHE_SIZE_BYTES
    ) {
      const nodeToEvict = this.lruTail;
      const entry = this.caches.get(nodeToEvict.assetId);

      if (entry) {
        entry.buckets.delete(nodeToEvict.key);
        entry.lruNodes.delete(nodeToEvict.key);
      }

      this.currentSizeBytes -= nodeToEvict.sizeBytes;
      this.removeFromLRU(nodeToEvict);
    }
  }
}

export const waveformCacheService = new WaveformCacheServiceClass();
