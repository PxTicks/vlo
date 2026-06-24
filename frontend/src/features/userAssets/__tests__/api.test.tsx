import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Input } from "mediabunny";
import type { Asset, AssetFamily } from "../../../types/Asset";
import { assetService } from "../services/AssetService";
import { mediaProcessingService } from "../services/MediaProcessingService";
import { useAssetStore } from "../useAssetStore";
import {
  addLocalAsset,
  addLocalAssetWithFamily,
  deleteAsset,
  ensureAssetFileLoaded,
  ensureAssetMetadataLoaded,
  ensureAssetSourceLoaded,
  flushAllAssetPersistence,
  getAssetById,
  getAssetInput,
  getAssets,
  getFamilies,
  getFamilyById,
  inspectAssetFamilyCompatibility,
  restoreDeletedAsset,
  scanForNewAssets,
  setFamilyRepresentative,
  upsertFamily,
  useAsset,
  useAssetSourceUrl,
  useFamily,
  waitForAssetPersistence,
  waitForAssetsPersistence,
} from "../api";

vi.mock("../services/MediaProcessingService", () => ({
  mediaProcessingService: {
    detectMimeType: vi.fn(),
    computeDuration: vi.fn(),
    generateVideoMetadata: vi.fn(),
  },
}));

const asset: Asset = {
  id: "asset-1",
  hash: "hash-1",
  name: "clip.mp4",
  type: "video",
  src: "assets/clip.mp4",
  createdAt: 1,
};

const family: AssetFamily = {
  id: "family-1",
  compatibility: {
    assetType: "video",
    durationMs: 2000,
    fpsMilli: 30000,
  },
  createdAt: 1,
  updatedAt: 1,
};

describe("userAssets api", () => {
  const addLocalAssetMock = vi.fn();
  const addLocalAssetWithFamilyMock = vi.fn();
  const upsertFamilyMock = vi.fn();
  const setFamilyRepresentativeMock = vi.fn();
  const deleteAssetMock = vi.fn();
  const restoreDeletedAssetMock = vi.fn();
  const scanForNewAssetsMock = vi.fn();
  const ensureAssetSourceLoadedMock = vi.fn();
  const ensureAssetMetadataLoadedMock = vi.fn();
  const getInputMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useAssetStore.setState({
      assets: [asset],
      families: [family],
      addLocalAsset: addLocalAssetMock,
      addLocalAssetWithFamily: addLocalAssetWithFamilyMock,
      upsertFamily: upsertFamilyMock,
      setFamilyRepresentative: setFamilyRepresentativeMock,
      deleteAsset: deleteAssetMock,
      restoreDeletedAsset: restoreDeletedAssetMock,
      scanForNewAssets: scanForNewAssetsMock,
      ensureAssetSourceLoaded: ensureAssetSourceLoadedMock,
      ensureAssetMetadataLoaded: ensureAssetMetadataLoadedMock,
      getInput: getInputMock,
    });
  });

  it("selects assets and families through hooks and synchronous getters", () => {
    expect(renderHook(() => useAsset("asset-1")).result.current).toEqual(asset);
    expect(renderHook(() => useAsset(null)).result.current).toBeUndefined();
    expect(renderHook(() => useFamily("family-1")).result.current).toEqual(family);
    expect(renderHook(() => useFamily(undefined)).result.current).toBeUndefined();
    expect(getAssets()).toEqual([asset]);
    expect(getAssetById("asset-1")).toEqual(asset);
    expect(getAssetById("missing")).toBeUndefined();
    expect(getAssetById(null)).toBeUndefined();
    expect(getFamilies()).toEqual([family]);
    expect(getFamilyById("family-1")).toEqual(family);
    expect(getFamilyById("missing")).toBeUndefined();
    expect(getFamilyById(undefined)).toBeUndefined();
  });

  it("delegates asset and family mutations to the store", async () => {
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
    const created = { ...asset, file };
    const input = { dispose: vi.fn() } as unknown as Input;
    addLocalAssetMock.mockResolvedValue(created);
    addLocalAssetWithFamilyMock.mockResolvedValue(created);
    restoreDeletedAssetMock.mockResolvedValue(created);
    ensureAssetSourceLoadedMock.mockResolvedValue(created);
    ensureAssetMetadataLoadedMock.mockResolvedValue(created);
    getInputMock.mockResolvedValue(input);

    await expect(
      addLocalAsset(file, { source: "uploaded" }, "family-1", {
        allowDuplicateHash: true,
      }),
    ).resolves.toEqual(created);
    await expect(
      addLocalAssetWithFamily(
        file,
        { source: "uploaded" },
        family,
        family.compatibility,
      ),
    ).resolves.toEqual(created);
    await upsertFamily(family);
    await setFamilyRepresentative("family-1", "asset-1");
    await deleteAsset("asset-1", { cleanupMode: "deferred" });
    await expect(restoreDeletedAsset("asset-1")).resolves.toEqual(created);
    await scanForNewAssets();
    await expect(ensureAssetSourceLoaded("asset-1")).resolves.toEqual(created);
    await expect(ensureAssetMetadataLoaded("asset-1")).resolves.toEqual(created);
    await expect(ensureAssetFileLoaded("asset-1")).resolves.toBe(file);
    ensureAssetSourceLoadedMock.mockResolvedValueOnce(null);
    await expect(ensureAssetFileLoaded("missing")).resolves.toBeNull();
    await expect(getAssetInput("asset-1")).resolves.toBe(input);

    expect(addLocalAssetMock).toHaveBeenCalledWith(
      file,
      { source: "uploaded" },
      "family-1",
      { allowDuplicateHash: true },
    );
    expect(addLocalAssetWithFamilyMock).toHaveBeenCalledWith(
      file,
      { source: "uploaded" },
      family,
      family.compatibility,
    );
    expect(setFamilyRepresentativeMock).toHaveBeenCalledWith(
      "family-1",
      "asset-1",
    );
    expect(deleteAssetMock).toHaveBeenCalledWith("asset-1", {
      cleanupMode: "deferred",
    });
  });

  it("returns hydrated URLs immediately and avoids unnecessary loading", () => {
    useAssetStore.setState({
      assets: [{ ...asset, src: "https://cdn.test/clip.mp4" }],
    });
    const { result } = renderHook(() => useAssetSourceUrl("asset-1"));
    expect(result.current).toBe("https://cdn.test/clip.mp4");
    expect(ensureAssetSourceLoadedMock).not.toHaveBeenCalled();
  });

  it("hydrates lazy source URLs and synchronizes later asset changes", async () => {
    ensureAssetSourceLoadedMock.mockResolvedValue({
      ...asset,
      src: "blob:hydrated",
    });
    const { result } = renderHook(() => useAssetSourceUrl("asset-1"));

    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe("blob:hydrated"));

    act(() => {
      useAssetStore.setState({
        assets: [{ ...asset, src: "http://cdn.test/replacement.mp4" }],
      });
    });
    await waitFor(() =>
      expect(result.current).toBe("http://cdn.test/replacement.mp4"),
    );
  });

  it("does not hydrate disabled or missing assets", () => {
    expect(
      renderHook(() => useAssetSourceUrl("asset-1", false)).result.current,
    ).toBeNull();
    expect(
      renderHook(() => useAssetSourceUrl("missing")).result.current,
    ).toBeNull();
    expect(ensureAssetSourceLoadedMock).not.toHaveBeenCalled();
  });

  it("ignores a lazy hydration result after unmount", async () => {
    let resolveHydration: (value: Asset) => void = () => undefined;
    ensureAssetSourceLoadedMock.mockReturnValue(
      new Promise<Asset>((resolve) => {
        resolveHydration = resolve;
      }),
    );
    const { unmount } = renderHook(() => useAssetSourceUrl("asset-1"));
    unmount();

    await act(async () => {
      resolveHydration({ ...asset, src: "blob:too-late" });
      await Promise.resolve();
    });
    expect(ensureAssetSourceLoadedMock).toHaveBeenCalledWith("asset-1");
  });

  it("inspects image, audio, and video family compatibility", async () => {
    vi.mocked(mediaProcessingService.detectMimeType).mockResolvedValue("image/png");
    await expect(
      inspectAssetFamilyCompatibility(
        new File(["image"], "unknown.bin", {
          type: "application/octet-stream",
        }),
      ),
    ).resolves.toEqual({
      assetType: "image",
      durationMs: 5000,
      fpsMilli: null,
    });

    vi.mocked(mediaProcessingService.computeDuration).mockResolvedValue(2.345);
    await expect(
      inspectAssetFamilyCompatibility(
        new File(["audio"], "sound.wav", { type: "audio/wav" }),
      ),
    ).resolves.toEqual({
      assetType: "audio",
      durationMs: 2345,
      fpsMilli: null,
    });

    vi.mocked(mediaProcessingService.generateVideoMetadata)
      .mockResolvedValueOnce({ duration: 3.5, fps: 29.97, thumbnail: null })
      .mockResolvedValueOnce({ duration: 1, fps: 0, thumbnail: null });
    await expect(
      inspectAssetFamilyCompatibility(
        new File(["video"], "movie.mp4", { type: "video/mp4" }),
      ),
    ).resolves.toEqual({
      assetType: "video",
      durationMs: 3500,
      fpsMilli: 29970,
    });
    await expect(
      inspectAssetFamilyCompatibility(
        new File(["video"], "invalid-fps.mp4", { type: "video/mp4" }),
      ),
    ).resolves.toEqual({
      assetType: "video",
      durationMs: 1000,
      fpsMilli: null,
    });
  });

  it("returns null when MIME detection cannot identify a supported family", async () => {
    vi.mocked(mediaProcessingService.detectMimeType).mockResolvedValue("");
    await expect(
      inspectAssetFamilyCompatibility(
        new File(["data"], "notes.txt", { type: "text/plain" }),
      ),
    ).resolves.toBeNull();
    await expect(
      inspectAssetFamilyCompatibility(
        new File(["data"], "data.json", { type: "application/json" }),
      ),
    ).resolves.toBeNull();
  });

  it("delegates persistence barriers to the asset service", async () => {
    const one = vi
      .spyOn(assetService, "waitForAssetPersistence")
      .mockResolvedValue(undefined);
    const many = vi
      .spyOn(assetService, "waitForAssetsPersistence")
      .mockResolvedValue(undefined);
    const all = vi
      .spyOn(assetService, "waitForAllAssetPersistence")
      .mockResolvedValue(undefined);

    await waitForAssetPersistence("asset-1");
    await waitForAssetsPersistence(["asset-1", "asset-2"]);
    await flushAllAssetPersistence();

    expect(one).toHaveBeenCalledWith("asset-1");
    expect(many).toHaveBeenCalledWith(["asset-1", "asset-2"]);
    expect(all).toHaveBeenCalledTimes(1);
  });
});
