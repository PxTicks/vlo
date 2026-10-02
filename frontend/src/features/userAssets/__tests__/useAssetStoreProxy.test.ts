import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAssetStore } from "../useAssetStore";
import { assetService } from "../services/AssetService";
import { proxyGenerationService } from "../services/ProxyGenerationService";
import { projectPersistenceService } from "../../project/services/ProjectPersistenceService";
import { projectMutationGuard } from "../../../core/project/projectMutationGuard";
import type { Asset } from "../../../types/Asset";

const { disk, projectHandle, generateProxyVideo, computeChecksum } = vi.hoisted(() => ({
  disk: new Map<string, File>(),
  projectHandle: { current: { name: "Project" } as object },
  generateProxyVideo: vi.fn(),
  computeChecksum: vi.fn(),
}));

function notFound(path: string): DOMException {
  return new DOMException(`${path} not found`, "NotFoundError");
}

// An in-memory project folder, so the real asset index persistence runs.
vi.mock("../../project/services/FileSystemService", () => {
  const toFile = (content: string | Blob, path: string) => {
    const file = new File([content], path.split("/").pop() ?? path);
    if (typeof content === "string") {
      Object.defineProperty(file, "text", { value: async () => content });
    }
    return file;
  };
  return {
    fileSystemService: {
      getHandle: vi.fn(() => projectHandle.current),
      readFile: vi.fn(async (path: string) => {
        const file = disk.get(path);
        if (!file) throw notFound(path);
        return file;
      }),
      writeFile: vi.fn(async (path: string, content: string | Blob) => {
        disk.set(path, toFile(content, path));
      }),
      saveAssetFile: vi.fn(async (file: File, path: string) => {
        disk.set(path, file);
      }),
      deleteFile: vi.fn(async (path: string) => {
        disk.delete(path);
      }),
      listDirectory: vi.fn(async () => []),
    },
  };
});

vi.mock("../../project/useProjectStore", () => ({
  useProjectStore: {
    getState: vi.fn(() => ({ rootHandle: {} })),
  },
}));

vi.mock("../../timeline/api", () => ({
  removeTimelineClipsByAssetId: vi.fn(() => 0),
}));

vi.mock("../services/MediaProcessingService", () => ({
  mediaProcessingService: {
    computeChecksum,
    computeDuration: vi.fn(async () => 10),
    sanitizeFilename: vi.fn((name: string) => name),
    generateImageThumbnail: vi.fn(async () => new Blob(["thumb"])),
    generateProxyVideo,
    createProcessor: vi.fn(() => ({
      detectMimeType: vi.fn(),
      computeDuration: vi.fn(async () => 10),
      generateVideoMetadata: vi.fn(async () => ({
        duration: 10,
        thumbnail: null,
        fps: 30,
      })),
      hasAudioTrack: vi.fn(async () => false),
      dispose: vi.fn(),
    })),
  },
}));

const ASSET_INDEX = ".vloproject/assets.json";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function video(name: string): File {
  return new File([name], name, { type: "video/mp4" });
}

async function readIndexEntry(assetId: string) {
  projectPersistenceService.resetCaches();
  const index = await projectPersistenceService.readAssetIndex();
  return index.assets[assetId];
}

function storeAsset(assetId: string): Asset | undefined {
  return useAssetStore.getState().assets.find((asset) => asset.id === assetId);
}

describe("useAssetStore - background proxies", () => {
  beforeEach(() => {
    disk.clear();
    projectHandle.current = { name: "Project" };
    projectPersistenceService.resetCaches();
    generateProxyVideo.mockReset();
    computeChecksum.mockReset();
    computeChecksum.mockImplementation(async (file: File) => `hash-${file.name}`);
    useAssetStore.setState({
      assets: [],
      families: [],
      isUploading: false,
      uploadingCount: 0,
      inputCache: new Map(),
    });
  });

  afterEach(async () => {
    proxyGenerationService.cancelAll();
    await proxyGenerationService.whenIdle();
  });

  it("makes an imported video usable before its proxy, then records the proxy", async () => {
    const proxyReady = deferred<Blob | null>();
    generateProxyVideo.mockImplementation(() => proxyReady.promise);

    const asset = await useAssetStore
      .getState()
      .addLocalAsset(video("import.mp4"), { source: "uploaded" });

    // 1. Imported while the transcode is still pending.
    expect(asset).not.toBeNull();
    await assetService.waitForAssetPersistence(asset!.id);
    expect(storeAsset(asset!.id)?.proxyFile).toBeUndefined();
    expect(await readIndexEntry(asset!.id)).toMatchObject({
      src: "import.mp4",
    });
    expect((await readIndexEntry(asset!.id))?.proxySrc).toBeUndefined();
    expect(generateProxyVideo).toHaveBeenCalledTimes(1);

    // 2. The proxy lands on disk, in the index, and in the store.
    proxyReady.resolve(new Blob(["proxy"], { type: "video/mp4" }));
    await proxyGenerationService.whenIdle();

    const proxyPath = ".vloproject/proxies/import.mp4_proxy.mp4";
    expect(disk.has(proxyPath)).toBe(true);
    expect((await readIndexEntry(asset!.id))?.proxySrc).toBe(proxyPath);
    expect(storeAsset(asset!.id)).toMatchObject({ proxyPath });
    expect(storeAsset(asset!.id)?.proxyFile).toBeInstanceOf(Blob);
  });

  it("shows each file of a multi-file import as soon as it is ingested", async () => {
    generateProxyVideo.mockResolvedValue(null);
    const secondHash = deferred<string>();
    computeChecksum.mockImplementation(async (file: File) =>
      file.name === "second.mp4" ? secondHash.promise : `hash-${file.name}`,
    );

    const importing = useAssetStore
      .getState()
      .addLocalAssets([video("first.mp4"), video("second.mp4")], {
        source: "uploaded",
      });

    await vi.waitFor(() =>
      expect(useAssetStore.getState().assets.map((a) => a.name)).toEqual([
        "first.mp4",
      ]),
    );

    secondHash.resolve("hash-second");
    const result = await importing;
    expect(result.assets).toHaveLength(2);
    expect(useAssetStore.getState().assets.map((a) => a.name)).toEqual([
      "first.mp4",
      "second.mp4",
    ]);
  });

  it("drops a proxy whose asset is deleted while it is generated", async () => {
    const proxyReady = deferred<Blob | null>();
    generateProxyVideo.mockImplementation(() => proxyReady.promise);

    const asset = await useAssetStore
      .getState()
      .addLocalAsset(video("doomed.mp4"), { source: "uploaded" });
    await assetService.waitForAssetPersistence(asset!.id);

    await useAssetStore.getState().deleteAsset(asset!.id);
    proxyReady.resolve(new Blob(["proxy"]));
    await proxyGenerationService.whenIdle();

    expect(disk.has(".vloproject/proxies/doomed.mp4_proxy.mp4")).toBe(false);
    expect(await readIndexEntry(asset!.id)).toBeUndefined();
  });

  it("lets an export start while a proxy is pending and commits it afterwards", async () => {
    const proxyReady = deferred<Blob | null>();
    generateProxyVideo.mockImplementation(() => proxyReady.promise);

    const asset = await useAssetStore
      .getState()
      .addLocalAsset(video("exporting.mp4"), { source: "uploaded" });
    await assetService.waitForAssetPersistence(asset!.id);

    const lease = await projectMutationGuard.acquire();
    try {
      proxyReady.resolve(new Blob(["proxy"]));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(storeAsset(asset!.id)?.proxyFile).toBeUndefined();
    } finally {
      lease.release();
    }

    await vi.waitFor(() =>
      expect(storeAsset(asset!.id)?.proxyFile).toBeInstanceOf(Blob),
    );
  });

  it("writes nothing once another project is open", async () => {
    const proxyReady = deferred<Blob | null>();
    generateProxyVideo.mockImplementation(() => proxyReady.promise);

    const asset = await useAssetStore
      .getState()
      .addLocalAsset(video("switched.mp4"), { source: "uploaded" });
    await assetService.waitForAssetPersistence(asset!.id);

    // The closing hook cancels too; this covers a handle swap it missed.
    projectHandle.current = { name: "Other project" };
    proxyReady.resolve(new Blob(["proxy"]));
    await proxyGenerationService.whenIdle();

    expect(disk.has(".vloproject/proxies/switched.mp4_proxy.mp4")).toBe(false);
    expect(storeAsset(asset!.id)?.proxyFile).toBeUndefined();
  });

  it("regenerates a missing proxy when the project loads", async () => {
    generateProxyVideo.mockResolvedValue(new Blob(["proxy"]));
    disk.set("missing.mp4", video("missing.mp4"));
    disk.set("present.mp4", video("present.mp4"));
    disk.set(
      ".vloproject/proxies/present.mp4_proxy.mp4",
      new File(["proxy"], "present.mp4_proxy.mp4"),
    );
    const indexText = JSON.stringify({
      documentType: "vlo.assets",
      schemaVersion: 1,
      updated_at: 1,
      assets: {
        "load-missing": {
          id: "load-missing",
          name: "missing.mp4",
          hash: "hash-missing",
          src: "missing.mp4",
          type: "video",
          createdAt: 1,
        },
        "load-present": {
          id: "load-present",
          name: "present.mp4",
          hash: "hash-present",
          src: "present.mp4",
          proxySrc: ".vloproject/proxies/present.mp4_proxy.mp4",
          type: "video",
          createdAt: 2,
        },
      },
      assetFamilies: {},
    });
    const indexFile = new File([indexText], "assets.json");
    Object.defineProperty(indexFile, "text", { value: async () => indexText });
    disk.set(ASSET_INDEX, indexFile);

    await useAssetStore.getState().fetchAssets();
    await vi.waitFor(() =>
      expect(storeAsset("load-missing")?.proxyFile).toBeInstanceOf(Blob),
    );

    expect(generateProxyVideo).toHaveBeenCalledTimes(1);
    expect(generateProxyVideo.mock.calls[0][0].name).toBe("missing.mp4");
    expect((await readIndexEntry("load-missing"))?.proxySrc).toBe(
      ".vloproject/proxies/missing.mp4_proxy.mp4",
    );
  });
});
