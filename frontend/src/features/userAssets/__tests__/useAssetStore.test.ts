import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAssetStore } from "../useAssetStore";
import { fileSystemService } from "../../project/services/FileSystemService";
import { projectDocumentService } from "../../project/services/ProjectDocumentService";
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
} else {
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:mocked-url") });
}

describe("useAssetStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRemoveClipsByAssetId.mockReset();
    projectDocumentService.resetProjectDocumentCache();
    useAssetStore.setState({ assets: [], isLoading: false });
  });

  it("fetchAssets should hydrate proxyFile from local FS", async () => {
    // Arrange
    (useProjectStore.getState as Mock).mockReturnValue({ rootHandle: {} });

    const mockProjectJson = JSON.stringify({
      assets: {
        "asset-1": {
          id: "asset-1",
          src: "video.mp4",
          proxySrc: ".vloproject/proxies/video_proxy.mp4",
          type: "video",
        },
      },
    });

    const mockFile = new File([""], "video.mp4");
    const mockProxyBlob = new Blob(["proxy-data"], { type: "video/mp4" });

    (fileSystemService.readFile as Mock).mockImplementation(
      async (path: string) => {
        if (path === ".vloproject/project.json") {
          return { text: async () => mockProjectJson };
        }
        if (path === "video.mp4") return mockFile;
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
    expect(assets[0].proxySrc).toBe("blob:mocked-url"); // Should be convt to blob URL
    expect(assets[0].proxyFile).toBeDefined();
    // Check if the Blob is actually the one we returned
    // Strict equality check on Blob instances might work if reference is preserved
    expect(assets[0].proxyFile).toBe(mockProxyBlob);
  });

  it("deleteAsset should remove entries from project.json and delete files from disk", async () => {
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

    // 2. Mock project.json content
    const mockProjectJson = JSON.stringify({
      assets: {
        [assetId]: {
          id: assetId,
          src: "test.mp4",
          thumbnail: ".vloproject/thumbnails/test_thumb.webp",
          proxySrc: ".vloproject/proxies/test_proxy.mp4",
        },
        "other-asset": {
          id: "other-asset",
          src: "other.mp4",
        },
      },
    });

    (fileSystemService.readFile as Mock).mockImplementation(
      async (path: string) => {
        if (path === ".vloproject/project.json") {
          return { text: async () => mockProjectJson };
        }
        throw new Error("File not found");
      },
    );

    // Act
    await useAssetStore.getState().deleteAsset(assetId);

    // Assert
    // 1. Check memory update
    expect(useAssetStore.getState().assets).toHaveLength(0);

    // 2. Check project.json update
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/project.json",
      expect.stringContaining('"other-asset"'), // Should keep other asset
    );
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/project.json",
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

    const mockProjectJson = JSON.stringify({
      assets: {
        "asset-audio": {
          id: "asset-audio",
          name: "song.mp3",
          hash: "audio-hash",
          src: "song.mp3",
          type: "audio",
          duration: 0,
          createdAt: 1,
        },
      },
    });

    const audioFile = new File(["audio"], "song.mp3", { type: "audio/mpeg" });
    vi.mocked(mediaProcessingService.computeDuration).mockResolvedValue(42.75);
    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      if (path === ".vloproject/project.json") {
        return { text: async () => mockProjectJson };
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
      ".vloproject/project.json",
      expect.stringContaining('"duration": 42.75'),
    );
  });

  it("updateAsset persists favourite changes to project.json", async () => {
    (useProjectStore.getState as Mock).mockReturnValue({ rootHandle: {} });

    useAssetStore.setState({
      assets: [
        {
          id: "asset-1",
          name: "clip.mp4",
          hash: "hash-1",
          src: "blob:clip",
          type: "video",
          createdAt: 1,
          favourite: false,
        },
      ],
    });

    const mockProjectJson = JSON.stringify({
      assets: {
        "asset-1": {
          id: "asset-1",
          name: "clip.mp4",
          hash: "hash-1",
          src: "clip.mp4",
          type: "video",
          createdAt: 1,
          favourite: false,
        },
      },
    });

    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      if (path === ".vloproject/project.json") {
        return { text: async () => mockProjectJson };
      }
      throw new Error("File not found: " + path);
    });

    await useAssetStore.getState().updateAsset("asset-1", { favourite: true });

    expect(useAssetStore.getState().assets[0].favourite).toBe(true);
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/project.json",
      expect.stringContaining('"favourite": true'),
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
          type: "video",
          createdAt: 1,
          favourite: false,
        },
      ],
    });

    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      if (path === ".vloproject/project.json") {
        return {
          text: async () =>
            JSON.stringify({
              assets: {
                "asset-1": {
                  id: "asset-1",
                  name: "clip.mp4",
                  hash: "hash-1",
                  src: "clip.mp4",
                  type: "video",
                  createdAt: 1,
                  favourite: false,
                },
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
