import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAssetStore } from "../useAssetStore";
import { fileSystemService } from "../../project/services/FileSystemService";
import { projectPersistenceService } from "../../project/services/ProjectPersistenceService";
import { useProjectStore } from "../../project/useProjectStore";
import { mediaProcessingService } from "../services/MediaProcessingService";
import type { Mock } from "vitest";

const { mockRemoveClipsByAssetId } = vi.hoisted(() => ({
  mockRemoveClipsByAssetId: vi.fn(),
}));

vi.mock("../../project/services/FileSystemService", () => ({
  fileSystemService: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
  },
}));

vi.mock("../../project/useProjectStore", () => ({
  useProjectStore: {
    getState: vi.fn(),
  },
}));

vi.mock("../../timeline/useTimelineStore", () => ({
  useTimelineStore: {
    getState: () => ({
      removeClipsByAssetId: mockRemoveClipsByAssetId,
    }),
  },
}));

// Mock the timeline barrel (dynamically imported in deleteAsset)
vi.mock("../../timeline", () => ({
  useTimelineStore: {
    getState: () => ({
      removeClipsByAssetId: mockRemoveClipsByAssetId,
    }),
  },
}));

vi.mock("../services/MediaProcessingService", () => ({
  mediaProcessingService: {
    computeDuration: vi.fn(),
  },
}));

// Mock URL.createObjectURL
if (globalThis.URL) {
  globalThis.URL.createObjectURL = vi.fn(() => "blob:mocked-url");
  globalThis.URL.revokeObjectURL = vi.fn();
} else {
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:mocked-url"),
    revokeObjectURL: vi.fn(),
  });
}

describe("useAssetStore", () => {
  function makeAssetIndex(
    assets: Record<string, unknown>,
    assetFamilies: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      documentType: "vlo.assets",
      schemaVersion: 1,
      updated_at: 1,
      assets,
      assetFamilies,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockRemoveClipsByAssetId.mockReset();
    projectPersistenceService.resetCaches();
    useAssetStore.setState({
      assets: [],
      families: [],
      isLoading: false,
      inputCache: new Map(),
    });
  });

  it("fetchAssets should keep video sources lazy while hydrating proxyFile from local FS", async () => {
    // Arrange
    (useProjectStore.getState as Mock).mockReturnValue({ rootHandle: {} });

    const mockAssetIndex = makeAssetIndex({
        "asset-1": {
          id: "asset-1",
          name: "video.mp4",
          hash: "video-hash",
          src: "video.mp4",
          proxySrc: ".vloproject/proxies/video_proxy.mp4",
          type: "video",
          createdAt: 1,
        },
    });

    const mockProxyBlob = new Blob(["proxy-data"], { type: "video/mp4" });

    (fileSystemService.readFile as Mock).mockImplementation(
      async (path: string) => {
        if (path === ".vloproject/assets.json") {
          return { text: async () => mockAssetIndex };
        }
        if (path === ".vloproject/proxies/video_proxy.mp4")
          return mockProxyBlob;
        throw new Error("File not found: " + path);
      },
    );

    // Act
    await useAssetStore.getState().fetchAssets();

    // Assert
    const assets = useAssetStore.getState().assets;
    expect(assets).toHaveLength(1);
    expect(assets[0].src).toBe("video.mp4");
    expect(assets[0].sourcePath).toBe("video.mp4");
    expect(assets[0].file).toBeUndefined();
    expect(assets[0].proxySrc).toBe("blob:mocked-url"); // Should be convt to blob URL
    expect(assets[0].proxyFile).toBeDefined();
    // Check if the Blob is actually the one we returned
    // Strict equality check on Blob instances might work if reference is preserved
    expect(assets[0].proxyFile).toBe(mockProxyBlob);
    expect(fileSystemService.readFile).not.toHaveBeenCalledWith("video.mp4");
  });

  it("ensureAssetSourceLoaded hydrates a lazy video source on demand", async () => {
    (useProjectStore.getState as Mock).mockReturnValue({ rootHandle: {} });

    const mockAssetIndex = makeAssetIndex({
        "asset-1": {
          id: "asset-1",
          name: "video.mp4",
          hash: "video-hash",
          src: "video.mp4",
          type: "video",
          createdAt: 1,
        },
    });

    const mockFile = new File(["video"], "video.mp4", { type: "video/mp4" });
    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      if (path === ".vloproject/assets.json") {
        return { text: async () => mockAssetIndex };
      }
      if (path === "video.mp4") {
        return mockFile;
      }
      throw new Error("File not found: " + path);
    });

    await useAssetStore.getState().fetchAssets();

    const hydrated = await useAssetStore.getState().ensureAssetSourceLoaded("asset-1");
    expect(hydrated?.src).toBe("blob:mocked-url");
    expect(hydrated?.file).toBe(mockFile);
    expect(useAssetStore.getState().assets[0]?.file).toBe(mockFile);
    expect(fileSystemService.readFile).toHaveBeenCalledWith("video.mp4");
  });

  it("deleteAsset should remove entries from assets.json and delete files from disk", async () => {
    // Arrange
    // 1. Setup initial state with an asset
    const assetId = "asset-to-delete";
    const initialAssets = [
      {
        id: assetId,
        name: "test.mp4",
        src: "blob:some-url", // In memory it's a blob
      },
    ];
    // @ts-expect-error - Partial mock for testing purposes
    useAssetStore.setState({ assets: initialAssets });

    // 2. Mock assets.json content
    const mockAssetIndex = makeAssetIndex({
        [assetId]: {
          id: assetId,
          name: "test.mp4",
          hash: "hash-delete",
          src: "test.mp4",
          thumbnail: ".vloproject/thumbnails/test_thumb.webp",
          proxySrc: ".vloproject/proxies/test_proxy.mp4",
          type: "video",
          createdAt: 1,
        },
        "other-asset": {
          id: "other-asset",
          name: "other.mp4",
          hash: "hash-other",
          src: "other.mp4",
          type: "video",
          createdAt: 2,
        },
    });

    (fileSystemService.readFile as Mock).mockImplementation(
      async (path: string) => {
        if (path === ".vloproject/assets.json") {
          return { text: async () => mockAssetIndex };
        }
        throw new Error("File not found");
      },
    );

    // Act
    await useAssetStore.getState().deleteAsset(assetId);

    // Assert
    // 1. Check memory update
    expect(useAssetStore.getState().assets).toHaveLength(0);

    // 2. Check assets.json update
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/assets.json",
      expect.stringContaining('"other-asset"'), // Should keep other asset
    );
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/assets.json",
      expect.not.stringContaining(assetId), // Should remove deleted asset
    );

    // 3. Check file deletions using paths from JSON, NOT from memory state
    expect(fileSystemService.deleteFile).toHaveBeenCalledWith("test.mp4");
    expect(fileSystemService.deleteFile).toHaveBeenCalledWith(
      ".vloproject/thumbnails/test_thumb.webp",
    );
    expect(fileSystemService.deleteFile).toHaveBeenCalledWith(
      ".vloproject/proxies/test_proxy.mp4",
    );
    expect(mockRemoveClipsByAssetId).toHaveBeenCalledWith(assetId);
  });

  it("fetchAssets repairs persisted audio durations when metadata is missing", async () => {
    (useProjectStore.getState as Mock).mockReturnValue({ rootHandle: {} });

    const mockAssetIndex = makeAssetIndex({
        "asset-audio": {
          id: "asset-audio",
          name: "song.mp3",
          hash: "audio-hash",
          src: "song.mp3",
          type: "audio",
          duration: 0,
          createdAt: 1,
        },
    });

    const audioFile = new File(["audio"], "song.mp3", { type: "audio/mpeg" });
    vi.mocked(mediaProcessingService.computeDuration).mockResolvedValue(42.75);
    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      if (path === ".vloproject/assets.json") {
        return { text: async () => mockAssetIndex };
      }
      if (path === "song.mp3") {
        return audioFile;
      }
      throw new Error("File not found: " + path);
    });

    await useAssetStore.getState().fetchAssets();

    const assets = useAssetStore.getState().assets;
    expect(assets).toHaveLength(1);
    expect(assets[0].duration).toBe(42.75);
    expect(mediaProcessingService.computeDuration).toHaveBeenCalledWith(
      audioFile,
    );
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/assets.json",
      expect.stringContaining('"duration": 42.75'),
    );
  });

  it("fetchAssets clears incompatible family references and drops empty families", async () => {
    (useProjectStore.getState as Mock).mockReturnValue({ rootHandle: {} });

    const mockAssetIndex = makeAssetIndex(
      {
        "asset-image": {
          id: "asset-image",
          name: "poster.png",
          hash: "image-hash",
          src: "poster.png",
          type: "image",
          familyId: "family-1",
          createdAt: 1,
        },
      },
      {
        "family-1": {
          id: "family-1",
          representativeAssetId: "asset-image",
          autoMatchKeys: ["generation-family:v1:image"],
          compatibility: {
            assetType: "video",
            durationMs: 5000,
            fpsMilli: 24000,
          },
          createdAt: 1,
          updatedAt: 1,
        },
      },
    );

    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      if (path === ".vloproject/assets.json") {
        return { text: async () => mockAssetIndex };
      }
      if (path === "poster.png") {
        return new File(["image"], "poster.png", { type: "image/png" });
      }
      throw new Error("File not found: " + path);
    });

    await useAssetStore.getState().fetchAssets();

    expect(useAssetStore.getState().assets).toEqual([
      expect.objectContaining({
        id: "asset-image",
        familyId: undefined,
      }),
    ]);
    expect(useAssetStore.getState().families).toEqual([]);
  });

  it("updateAsset persists favourite changes to assets.json", async () => {
    (useProjectStore.getState as Mock).mockReturnValue({ rootHandle: {} });

    useAssetStore.setState({
      assets: [
        {
          id: "asset-1",
          name: "clip.mp4",
          hash: "hash-1",
          src: "blob:clip",
          sourcePath: "clip.mp4",
          type: "video",
          createdAt: 1,
          favourite: false,
        },
      ],
    });

    const mockAssetIndex = makeAssetIndex({
        "asset-1": {
          id: "asset-1",
          name: "clip.mp4",
          hash: "hash-1",
          src: "clip.mp4",
          type: "video",
          createdAt: 1,
          favourite: false,
        },
    });

    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      if (path === ".vloproject/assets.json") {
        return { text: async () => mockAssetIndex };
      }
      throw new Error("File not found: " + path);
    });

    await useAssetStore.getState().updateAsset("asset-1", { favourite: true });

    expect(useAssetStore.getState().assets[0].favourite).toBe(true);
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/assets.json",
      expect.stringContaining('"favourite": true'),
    );
  });

  it("setFamilyRepresentative updates the stored representative", async () => {
    (useProjectStore.getState as Mock).mockReturnValue({ rootHandle: {} });

    useAssetStore.setState({
      assets: [
        {
          id: "asset-1",
          name: "clip-a.mp4",
          hash: "hash-1",
          src: "blob:clip-a",
          sourcePath: "clip-a.mp4",
          type: "video",
          familyId: "family-1",
          duration: 5,
          fps: 24,
          createdAt: 1,
        },
        {
          id: "asset-2",
          name: "clip-b.mp4",
          hash: "hash-2",
          src: "blob:clip-b",
          sourcePath: "clip-b.mp4",
          type: "video",
          familyId: "family-1",
          duration: 5,
          fps: 24,
          createdAt: 2,
        },
      ],
      families: [
        {
          id: "family-1",
          representativeAssetId: "asset-1",
          autoMatchKeys: ["generation-family:v1:test"],
          compatibility: {
            assetType: "video",
            durationMs: 5000,
            fpsMilli: 24000,
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const mockAssetIndex = makeAssetIndex(
      {
        "asset-1": {
          id: "asset-1",
          name: "clip-a.mp4",
          hash: "hash-1",
          src: "clip-a.mp4",
          type: "video",
          familyId: "family-1",
          createdAt: 1,
        },
        "asset-2": {
          id: "asset-2",
          name: "clip-b.mp4",
          hash: "hash-2",
          src: "clip-b.mp4",
          type: "video",
          familyId: "family-1",
          createdAt: 2,
        },
      },
      {
        "family-1": {
          id: "family-1",
          representativeAssetId: "asset-1",
          compatibility: {
            assetType: "video",
            durationMs: 5000,
            fpsMilli: 24000,
          },
          createdAt: 1,
          updatedAt: 1,
        },
      },
    );

    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      if (path === ".vloproject/assets.json") {
        return { text: async () => mockAssetIndex };
      }
      throw new Error("File not found: " + path);
    });

    await useAssetStore
      .getState()
      .setFamilyRepresentative("family-1", "asset-2");

    expect(useAssetStore.getState().families).toEqual([
      expect.objectContaining({
        id: "family-1",
        representativeAssetId: "asset-2",
      }),
    ]);
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/assets.json",
      expect.stringContaining('"representativeAssetId": "asset-2"'),
    );
  });

  it("updateAsset promotes the latest favourited family member to representative", async () => {
    (useProjectStore.getState as Mock).mockReturnValue({ rootHandle: {} });

    useAssetStore.setState({
      assets: [
        {
          id: "asset-1",
          name: "clip-a.mp4",
          hash: "hash-1",
          src: "blob:clip-a",
          sourcePath: "clip-a.mp4",
          type: "video",
          familyId: "family-1",
          duration: 5,
          fps: 24,
          createdAt: 1,
          favourite: false,
        },
        {
          id: "asset-2",
          name: "clip-b.mp4",
          hash: "hash-2",
          src: "blob:clip-b",
          sourcePath: "clip-b.mp4",
          type: "video",
          familyId: "family-1",
          duration: 5,
          fps: 24,
          createdAt: 2,
          favourite: false,
        },
      ],
      families: [
        {
          id: "family-1",
          representativeAssetId: "asset-1",
          autoMatchKeys: ["generation-family:v1:test"],
          compatibility: {
            assetType: "video",
            durationMs: 5000,
            fpsMilli: 24000,
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const mockAssetIndex = makeAssetIndex(
      {
        "asset-1": {
          id: "asset-1",
          name: "clip-a.mp4",
          hash: "hash-1",
          src: "clip-a.mp4",
          type: "video",
          familyId: "family-1",
          createdAt: 1,
          favourite: false,
        },
        "asset-2": {
          id: "asset-2",
          name: "clip-b.mp4",
          hash: "hash-2",
          src: "clip-b.mp4",
          type: "video",
          familyId: "family-1",
          createdAt: 2,
          favourite: false,
        },
      },
      {
        "family-1": {
          id: "family-1",
          representativeAssetId: "asset-1",
          compatibility: {
            assetType: "video",
            durationMs: 5000,
            fpsMilli: 24000,
          },
          createdAt: 1,
          updatedAt: 1,
        },
      },
    );

    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      if (path === ".vloproject/assets.json") {
        return { text: async () => mockAssetIndex };
      }
      throw new Error("File not found: " + path);
    });

    await useAssetStore.getState().updateAsset("asset-2", { favourite: true });

    expect(
      useAssetStore.getState().assets.find((asset) => asset.id === "asset-2")
        ?.favourite,
    ).toBe(true);
    expect(useAssetStore.getState().families).toEqual([
      expect.objectContaining({
        id: "family-1",
        representativeAssetId: "asset-2",
      }),
    ]);
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/assets.json",
      expect.stringContaining('"representativeAssetId": "asset-2"'),
    );
  });

  it("updateAsset rolls back the optimistic change when persistence fails", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    useAssetStore.setState({
      assets: [
        {
          id: "asset-1",
          name: "clip.mp4",
          hash: "hash-1",
          src: "blob:clip",
          sourcePath: "clip.mp4",
          type: "video",
          createdAt: 1,
          favourite: false,
        },
      ],
    });

    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      if (path === ".vloproject/assets.json") {
        return {
          text: async () =>
            makeAssetIndex({
                "asset-1": {
                  id: "asset-1",
                  name: "clip.mp4",
                  hash: "hash-1",
                  src: "clip.mp4",
                  type: "video",
                  createdAt: 1,
                  favourite: false,
                },
            }),
        };
      }

      throw new Error("File not found: " + path);
    });

    (fileSystemService.writeFile as Mock).mockRejectedValueOnce(
      new Error("disk full"),
    );

    await useAssetStore.getState().updateAsset("asset-1", { favourite: true });

    expect(useAssetStore.getState().assets[0].favourite).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to persist asset update for 'asset-1'",
      expect.any(Error),
    );
  });
});
