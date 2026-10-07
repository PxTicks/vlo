import { afterEach, describe, expect, it, vi } from "vitest";
import {
  thumbnailCacheService,
  type ThumbnailAssetMetadata,
} from "../ThumbnailCacheService";

const METADATA: ThumbnailAssetMetadata = {
  aspectRatio: 16 / 9,
  firstTimestampSeconds: 0,
};

const isVideoComplete = (metadata: ThumbnailAssetMetadata) =>
  metadata.firstTimestampSeconds !== undefined;

describe("ThumbnailCacheService.loadMetadata", () => {
  afterEach(() => {
    thumbnailCacheService.clearAll();
  });

  it("shares one in-flight probe between clips of the same asset", async () => {
    thumbnailCacheService.acquire("asset-1");
    thumbnailCacheService.acquire("asset-1");
    let resolveProbe!: (metadata: ThumbnailAssetMetadata) => void;
    const loader = vi.fn(
      () =>
        new Promise<ThumbnailAssetMetadata>((resolve) => {
          resolveProbe = resolve;
        }),
    );

    const first = thumbnailCacheService.loadMetadata(
      "asset-1",
      isVideoComplete,
      loader,
    );
    const second = thumbnailCacheService.loadMetadata(
      "asset-1",
      isVideoComplete,
      loader,
    );
    resolveProbe(METADATA);

    await expect(first).resolves.toEqual(METADATA);
    await expect(second).resolves.toEqual(METADATA);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(thumbnailCacheService.getMetadata("asset-1")).toEqual(METADATA);

    // Settled metadata is served from the cache without probing again.
    await thumbnailCacheService.loadMetadata(
      "asset-1",
      isVideoComplete,
      loader,
    );
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("re-probes when the in-flight probe read a different source", async () => {
    // A background proxy can land while a source probe is still running;
    // the proxy caller must not adopt the source's first timestamp.
    thumbnailCacheService.acquire("asset-1");
    let resolveSourceProbe!: (metadata: ThumbnailAssetMetadata) => void;
    const sourceProbe = vi.fn(
      () =>
        new Promise<ThumbnailAssetMetadata>((resolve) => {
          resolveSourceProbe = resolve;
        }),
    );
    const proxyMetadata: ThumbnailAssetMetadata = {
      ...METADATA,
      firstTimestampSeconds: 0,
      probedFromProxy: true,
    };
    const proxyProbe = vi.fn(async () => proxyMetadata);

    const fromSource = thumbnailCacheService.loadMetadata(
      "asset-1",
      (metadata) => !metadata.probedFromProxy,
      sourceProbe,
    );
    const fromProxy = thumbnailCacheService.loadMetadata(
      "asset-1",
      (metadata) => Boolean(metadata.probedFromProxy),
      proxyProbe,
    );
    const sourceMetadata = {
      ...METADATA,
      firstTimestampSeconds: 0.5,
      probedFromProxy: false,
    };
    resolveSourceProbe(sourceMetadata);

    await expect(fromSource).resolves.toEqual(sourceMetadata);
    await expect(fromProxy).resolves.toEqual(proxyMetadata);
    expect(proxyProbe).toHaveBeenCalledTimes(1);
    expect(thumbnailCacheService.getMetadata("asset-1")).toEqual(proxyMetadata);
  });

  it("probes when cached metadata is incomplete for the caller", async () => {
    // Image-style entries carry only an aspect ratio; a video caller still
    // needs its first timestamp probed.
    thumbnailCacheService.acquire("asset-1");
    thumbnailCacheService.setMetadata("asset-1", { aspectRatio: 4 / 3 });
    const loader = vi.fn(async () => METADATA);

    await expect(
      thumbnailCacheService.loadMetadata("asset-1", isVideoComplete, loader),
    ).resolves.toEqual(METADATA);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(thumbnailCacheService.getMetadata("asset-1")).toEqual(METADATA);
  });

  it("retries after a failed probe instead of caching the failure", async () => {
    thumbnailCacheService.acquire("asset-1");
    const failing = vi.fn(async () => {
      throw new Error("probe failed");
    });
    await expect(
      thumbnailCacheService.loadMetadata("asset-1", isVideoComplete, failing),
    ).rejects.toThrow("probe failed");

    const succeeding = vi.fn(async () => METADATA);
    await expect(
      thumbnailCacheService.loadMetadata(
        "asset-1",
        isVideoComplete,
        succeeding,
      ),
    ).resolves.toEqual(METADATA);
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("does not store metadata into a cache entry released mid-probe", async () => {
    thumbnailCacheService.acquire("asset-1");
    let resolveProbe!: (metadata: ThumbnailAssetMetadata) => void;
    const pending = thumbnailCacheService.loadMetadata(
      "asset-1",
      isVideoComplete,
      () =>
        new Promise<ThumbnailAssetMetadata>((resolve) => {
          resolveProbe = resolve;
        }),
    );

    thumbnailCacheService.release("asset-1");
    thumbnailCacheService.acquire("asset-1");
    resolveProbe(METADATA);

    await expect(pending).resolves.toEqual(METADATA);
    expect(thumbnailCacheService.getMetadata("asset-1")).toBeNull();
  });
});
