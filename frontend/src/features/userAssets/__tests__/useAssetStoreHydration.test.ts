import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Asset, AssetFamily } from "../../../types/Asset";

const { scanForNewAssets } = vi.hoisted(() => ({
  scanForNewAssets: vi.fn(),
}));

vi.mock("../../project/services/FileSystemService", () => ({
  fileSystemService: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    getHandle: vi.fn(() => null),
  },
}));

vi.mock("../services/AssetService", () => ({
  assetService: { scanForNewAssets },
}));

import { fileSystemService } from "../../project/services/FileSystemService";
import { projectPersistenceService } from "../../project/services/ProjectPersistenceService";
import { useProjectStore } from "../../project/useProjectStore";
import { useAssetStore } from "../useAssetStore";

const METADATA_REF = "asset-metadata/asset-1.json";
const CREATION_METADATA = {
  source: "generated" as const,
  workflowName: "Workflow",
  inputs: [],
};

function imageAsset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    name: `${id}.png`,
    type: "image",
    src: `${id}.png`,
    hash: `hash-${id}`,
    createdAt: 1,
    ...overrides,
  };
}

let files: Map<string, string>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useAssetStore hydration and scanning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectPersistenceService.resetCaches();
    files = new Map();
    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`File not found: ${path}`);
      return { text: async () => content };
    });
    (fileSystemService.writeFile as Mock).mockImplementation(
      async (path: string, content: string) => {
        files.set(path, content);
      },
    );
    useAssetStore.setState({
      assets: [],
      families: [],
      isLoading: false,
      isScanning: false,
      isUploading: false,
      uploadingCount: 0,
      inputCache: new Map(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useProjectStore.setState({ rootHandle: null });
  });

  describe("fetchAssets", () => {
    it("rethrows an unreadable asset index so callers can skip the disk scan", async () => {
      const existing = imageAsset("existing");
      useAssetStore.setState({ assets: [existing] });
      useProjectStore.setState({
        rootHandle: {} as FileSystemDirectoryHandle,
      });
      files.set(".vloproject/assets.json", "{ truncated");
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(useAssetStore.getState().fetchAssets()).rejects.toThrow();

      // The store is left as it was rather than emptied, and stops loading.
      expect(useAssetStore.getState().assets).toEqual([existing]);
      expect(useAssetStore.getState().isLoading).toBe(false);
    });
  });

  describe("ensureAssetMetadataLoaded", () => {
    function seedSidecar() {
      files.set(
        `.vloproject/${METADATA_REF}`,
        JSON.stringify({
          documentType: "vlo.assetMetadata",
          schemaVersion: 1,
          assetId: "asset-1",
          updated_at: 1,
          creationMetadata: CREATION_METADATA,
        }),
      );
    }

    it("hydrates sidecar metadata once, sharing a read between concurrent callers", async () => {
      seedSidecar();
      useAssetStore.setState({
        assets: [imageAsset("asset-1", { metadataRef: METADATA_REF })],
      });

      const [first, second] = await Promise.all([
        useAssetStore.getState().ensureAssetMetadataLoaded("asset-1"),
        useAssetStore.getState().ensureAssetMetadataLoaded("asset-1"),
      ]);

      expect(first).toMatchObject({
        id: "asset-1",
        metadataLoaded: true,
        creationMetadata: CREATION_METADATA,
      });
      expect(second).toBe(first);
      expect(useAssetStore.getState().assets[0]).toBe(first);
      const sidecarReads = (fileSystemService.readFile as Mock).mock.calls.filter(
        ([path]) => path === `.vloproject/${METADATA_REF}`,
      );
      expect(sidecarReads).toHaveLength(1);

      // Already hydrated: answered from the store without touching disk.
      (fileSystemService.readFile as Mock).mockClear();
      await expect(
        useAssetStore.getState().ensureAssetMetadataLoaded("asset-1"),
      ).resolves.toBe(first);
      expect(fileSystemService.readFile).not.toHaveBeenCalled();
    });

    it("keeps index metadata when the sidecar is missing", async () => {
      const indexMetadata = { ...CREATION_METADATA, workflowName: "From index" };
      useAssetStore.setState({
        assets: [
          imageAsset("asset-1", {
            metadataRef: METADATA_REF,
            creationMetadata: indexMetadata,
          }),
        ],
      });

      const asset = await useAssetStore
        .getState()
        .ensureAssetMetadataLoaded("asset-1");

      expect(asset).toMatchObject({
        metadataLoaded: true,
        creationMetadata: indexMetadata,
      });
    });

    it("returns null for unknown assets and skips assets without a sidecar", async () => {
      const inline = imageAsset("inline");
      useAssetStore.setState({ assets: [inline] });

      await expect(
        useAssetStore.getState().ensureAssetMetadataLoaded("missing"),
      ).resolves.toBeNull();
      await expect(
        useAssetStore.getState().ensureAssetMetadataLoaded("inline"),
      ).resolves.toBe(inline);
      expect(fileSystemService.readFile).not.toHaveBeenCalled();
    });

    it("returns null when the asset is deleted while its sidecar is being read", async () => {
      seedSidecar();
      const read = deferred<void>();
      const realRead = (fileSystemService.readFile as Mock).getMockImplementation()!;
      (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
        await read.promise;
        return realRead(path);
      });
      useAssetStore.setState({
        assets: [imageAsset("asset-1", { metadataRef: METADATA_REF })],
      });

      const pending = useAssetStore
        .getState()
        .ensureAssetMetadataLoaded("asset-1");
      useAssetStore.setState({ assets: [] });
      read.resolve();

      await expect(pending).resolves.toBeNull();
      expect(useAssetStore.getState().assets).toEqual([]);
    });
  });

  describe("scanForNewAssets", () => {
    it("adds discovered assets as they are created and clears the busy state", async () => {
      const existing = imageAsset("existing");
      const discovered = imageAsset("discovered");
      useAssetStore.setState({ assets: [existing] });
      scanForNewAssets.mockImplementation(
        async (known: Asset[], onCreated: (asset: Asset) => void) => {
          expect(known).toEqual([existing]);
          expect(useAssetStore.getState()).toMatchObject({
            isScanning: true,
            isUploading: true,
            uploadingCount: 1,
          });
          onCreated(discovered);
          return [discovered];
        },
      );

      await useAssetStore.getState().scanForNewAssets();

      expect(useAssetStore.getState()).toMatchObject({
        assets: [existing, discovered],
        isScanning: false,
        isUploading: false,
        uploadingCount: 0,
      });
    });

    it("refuses to start a second scan while one is running", async () => {
      const running = deferred<Asset[]>();
      scanForNewAssets.mockReturnValue(running.promise);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = useAssetStore.getState().scanForNewAssets();
      await vi.waitFor(() => expect(scanForNewAssets).toHaveBeenCalledTimes(1));
      await useAssetStore.getState().scanForNewAssets();

      expect(warn).toHaveBeenCalledWith("[Scanner] Scan already in progress.");
      expect(scanForNewAssets).toHaveBeenCalledTimes(1);
      running.resolve([]);
      await first;
      expect(useAssetStore.getState().isScanning).toBe(false);
    });

    it("recovers its busy state when the scan fails", async () => {
      scanForNewAssets.mockRejectedValue(new Error("directory gone"));
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      useAssetStore.setState({ uploadingCount: 1, isUploading: true });

      await useAssetStore.getState().scanForNewAssets();

      expect(error).toHaveBeenCalledWith(
        "Failed to scan assets directory",
        expect.any(Error),
      );
      // An unrelated upload that was already running keeps the flag up.
      expect(useAssetStore.getState()).toMatchObject({
        isScanning: false,
        uploadingCount: 1,
        isUploading: true,
      });
    });
  });

  describe("upsertFamily", () => {
    const family: AssetFamily = {
      id: "family-1",
      representativeAssetId: "a",
      compatibility: { assetType: "image", durationMs: null, fpsMilli: null },
      createdAt: 1,
      updatedAt: 1,
    };

    it("rolls back the optimistic family when the index write fails", async () => {
      const assets = [imageAsset("a")];
      useAssetStore.setState({ assets, families: [] });
      vi.spyOn(projectPersistenceService, "updateAssetIndex").mockRejectedValue(
        new Error("disk full"),
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await useAssetStore.getState().upsertFamily(family);

      expect(useAssetStore.getState().families).toEqual([]);
      expect(useAssetStore.getState().assets).toBe(assets);
    });
  });
});
