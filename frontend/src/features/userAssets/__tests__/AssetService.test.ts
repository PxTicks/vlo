import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  afterEach,
  type Mock,
} from "vitest";
import { assetService } from "../services/AssetService";
import { fileSystemService } from "../../project/services/FileSystemService";
import { projectPersistenceService } from "../../project/services/ProjectPersistenceService";
import { mediaProcessingService } from "../services/MediaProcessingService";
import type { Asset } from "../../../types/Asset";
import type { MediaFileProcessor } from "../services/MediaProcessingService";

// Mock dependencies
vi.mock("../../project/services/FileSystemService", () => ({
  fileSystemService: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    saveAssetFile: vi.fn(),
    renameFile: vi.fn(),
    listDirectory: vi.fn(),
  },
}));

const mockProcessor = {
  detectMimeType: vi.fn(),
  computeDuration: vi.fn().mockResolvedValue(0),
  generateVideoMetadata: vi.fn(),
  generateProxyVideo: vi.fn(),
  hasAudioTrack: vi.fn().mockResolvedValue(true),
  dispose: vi.fn(),
};

vi.mock("../services/MediaProcessingService", () => ({
  mediaProcessingService: {
    computeChecksum: vi.fn(),
    sanitizeFilename: vi.fn((name) => name.replace(/[^a-z0-9.]/gi, "_")),
    generateImageThumbnail: vi.fn(),
    createProcessor: vi.fn(() => mockProcessor),
  },
}));

// Mock URL.createObjectURL
if (globalThis.URL) {
  globalThis.URL.createObjectURL = vi.fn(
    () => "blob:http://localhost:3000/uuid",
  );
  globalThis.URL.revokeObjectURL = vi.fn();
} else {
  vi.stubGlobal(
    "URL",
    class {
      static createObjectURL = vi.fn(() => "blob:http://localhost:3000/uuid");
      static revokeObjectURL = vi.fn();
    },
  );
}

describe("AssetService", () => {
  const emptyAssetIndex = {
    documentType: "vlo.assets",
    schemaVersion: 1,
    updated_at: 1,
    assets: {},
    assetFamilies: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    projectPersistenceService.resetCaches();
    vi.mocked(mediaProcessingService.createProcessor).mockReturnValue(
      mockProcessor as unknown as MediaFileProcessor,
    );
    mockProcessor.computeDuration.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should scan and add new assets found in the directory and batch persist", async () => {
    // Arrange
    const mockFiles = ["existing.png", "new_image.png"];
    const mockFileContent = new File(["dummy"], "new_image.png", {
      type: "image/png",
    });

    // Mock File System
    (fileSystemService.listDirectory as Mock).mockResolvedValue(mockFiles);
    (fileSystemService.readFile as Mock).mockImplementation(
      async (path: string) => {
        if (path === "new_image.png") return mockFileContent;
        if (path === ".vloproject/assets.json") {
          return {
            text: async () => JSON.stringify(emptyAssetIndex),
            name: "assets.json",
          };
        }
        return new File([""], "unknown");
      },
    );

    // Mock Processing
    (mediaProcessingService.computeChecksum as Mock).mockResolvedValue(
      "hash-123",
    );
    (mediaProcessingService.generateImageThumbnail as Mock).mockResolvedValue(
      new Blob(["thumb"]),
    );

    // Simluate "existing.png" is already in store
    const existingAssets: Asset[] = [
      {
        id: "existing-id",
        name: "existing.png",
        hash: "old-hash",
        src: "existing.png",
        type: "image",
        createdAt: 1000,
        duration: 5,
      },
    ];

    // Act
    const newAssets = await assetService.scanForNewAssets(existingAssets);

    // Assert
    expect(fileSystemService.listDirectory).toHaveBeenCalledWith(".");

    // existing.png should be skipped
    expect(fileSystemService.readFile).toHaveBeenCalledWith("new_image.png");

    expect(newAssets).toHaveLength(1);
    const newAsset = newAssets[0];
    expect(newAsset.name).toBe("new_image.png");

    // Verify assets.json write happened (Batched)
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/assets.json",
      expect.stringContaining("new_image.png"),
    );

    expect(mockProcessor.dispose).toHaveBeenCalled();
  });

  it("should infer mime type via magic bytes if missing from file object", async () => {
    // Arrange
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const mockFileContent = new File([pngBytes], "inferred.png", { type: "" });

    (fileSystemService.listDirectory as Mock).mockResolvedValue([
      "inferred.png",
    ]);
    (fileSystemService.readFile as Mock).mockImplementation(
      async (path: string) => {
        if (path === "inferred.png") return mockFileContent;
        if (path === ".vloproject/assets.json")
          return { text: async () => JSON.stringify(emptyAssetIndex) };
        return new File([""], "unknown");
      },
    );

    // Mock processor behavior
    mockProcessor.detectMimeType.mockResolvedValue("image/png");

    (mediaProcessingService.generateImageThumbnail as Mock).mockResolvedValue(
      new Blob(["thumb"]),
    );

    // Act
    const newAssets = await assetService.scanForNewAssets([]);

    // Assert
    const asset = newAssets.find((a) => a.name === "inferred.png");
    expect(asset).toBeDefined();
    expect(asset?.type).toBe("image");
    expect(mediaProcessingService.generateImageThumbnail).toHaveBeenCalled();
    expect(mockProcessor.dispose).toHaveBeenCalled();
  });

  it("should not duplicate if file is already known", async () => {
    // Arrange
    (fileSystemService.listDirectory as Mock).mockResolvedValue(["known.png"]);

    const existingAsset = {
      id: "1",
      name: "known.png",
      hash: "hash",
      src: "known.png",
      type: "image" as const,
      createdAt: 0,
      duration: 0,
    };

    const spyIngest = vi.spyOn(assetService, "ingestAssetWithResult");

    // Act
    const newAssets = await assetService.scanForNewAssets([existingAsset]);

    // Assert
    expect(newAssets).toHaveLength(0);
    expect(spyIngest).not.toHaveBeenCalled();
  });

  it("should rename unsanitized file and ingest the new name if it does not exist", async () => {
    // Arrange
    // On disk: "fresh file.png" -> "fresh_file.png"
    (fileSystemService.listDirectory as Mock).mockResolvedValue([
      "fresh file.png",
    ]);

    const mockFileContent = new File(["dummy"], "fresh_file.png", {
      type: "image/png",
    }); // Simulating reading the RENAMED file

    (fileSystemService.readFile as Mock).mockImplementation(
      async (path: string) => {
        if (path === "fresh_file.png") return mockFileContent;
        if (path === ".vloproject/assets.json")
          return { text: async () => JSON.stringify(emptyAssetIndex) };
        return new File([""], "unknown");
      },
    );

    (mediaProcessingService.sanitizeFilename as Mock).mockImplementation(
      (name) => name.replace(/ /g, "_"),
    );
    (mediaProcessingService.computeChecksum as Mock).mockResolvedValue(
      "new-hash",
    );
    (mediaProcessingService.generateImageThumbnail as Mock).mockResolvedValue(
      new Blob(["thumb"]),
    );

    const spyIngest = vi.spyOn(assetService, "ingestAssetWithResult");

    // Act
    const newAssets = await assetService.scanForNewAssets([]);

    // Assert
    expect(fileSystemService.renameFile).toHaveBeenCalledWith(
      "fresh file.png",
      "fresh_file.png",
    );
    expect(spyIngest).toHaveBeenCalled();

    const asset = newAssets.find((a) => a.name === "fresh_file.png");
    expect(asset).toBeDefined();
    expect(asset?.name).toBe("fresh_file.png");
    expect(mockProcessor.dispose).toHaveBeenCalled();
  });
  it("should populate proxyFile when proxy is generated for video", async () => {
    // Arrange
    const videoFile = new File(["video"], "test.mp4", { type: "video/mp4" });
    const proxyBlob = new Blob(["proxy"], { type: "video/mp4" });

    (fileSystemService.listDirectory as Mock).mockResolvedValue(["test.mp4"]);
    (fileSystemService.readFile as Mock).mockImplementation(
      async (path: string) => {
        if (path === "test.mp4") return videoFile;
        if (path === ".vloproject/assets.json") {
          return {
            text: async () => JSON.stringify(emptyAssetIndex),
            name: "assets.json",
          };
        }
        return new File([""], "unknown");
      },
    );
    (mediaProcessingService.computeChecksum as Mock).mockResolvedValue("hash");

    mockProcessor.generateVideoMetadata.mockResolvedValue({
      duration: 10,
      thumbnail: new Blob(["thumb"]),
      fps: 30,
    });
    mockProcessor.generateProxyVideo.mockResolvedValue(proxyBlob);

    // Act
    const newAssets = await assetService.scanForNewAssets([]);

    // Assert
    const asset = newAssets[0];
    expect(asset).toBeDefined();
    expect(asset.type).toBe("video");
    expect(asset.fps).toBe(30);
    expect(asset.proxySrc).toBeDefined();
    expect(asset.proxyFile).toBe(proxyBlob); // Crucial check
    expect(mockProcessor.dispose).toHaveBeenCalled();
  });

  it("should preserve full audio duration during ingest", async () => {
    const audioFile = new File(["audio"], "song.mp3", { type: "audio/mpeg" });

    (fileSystemService.listDirectory as Mock).mockResolvedValue(["song.mp3"]);
    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      if (path === "song.mp3") return audioFile;
      if (path === ".vloproject/assets.json") {
        return {
          text: async () => JSON.stringify(emptyAssetIndex),
          name: "assets.json",
        };
      }
      return new File([""], "unknown");
    });
    (mediaProcessingService.computeChecksum as Mock).mockResolvedValue(
      "audio-hash",
    );
    mockProcessor.computeDuration.mockResolvedValue(42.75);

    const newAssets = await assetService.scanForNewAssets([]);

    expect(newAssets).toHaveLength(1);
    expect(newAssets[0].type).toBe("audio");
    expect(newAssets[0].duration).toBe(42.75);
    expect(mockProcessor.computeDuration).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing generation mask asset when the hash matches", async () => {
    const maskFile = new File(["mask"], "generation-mask.mp4", {
      type: "video/mp4",
    });

    (mediaProcessingService.computeChecksum as Mock).mockResolvedValue(
      "shared-mask-hash",
    );

    const existingMask: Asset = {
      id: "existing-mask",
      name: "existing-mask.mp4",
      hash: "shared-mask-hash",
      src: "existing-mask.mp4",
      type: "video",
      createdAt: 1,
      creationMetadata: {
        source: "generation_mask",
        parentGeneratedAssetId: "generated-1",
      },
    };

    const result = await assetService.ingestAssetWithResult(
      maskFile,
      true,
      true,
      [existingMask],
      {
        source: "generation_mask",
        parentGeneratedAssetId: "generated-2",
      },
    );

    expect(result).toEqual({
      status: "reused_existing",
      asset: existingMask,
      reason: "hash",
    });
    expect(mockProcessor.generateVideoMetadata).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "SAM2",
      creationMetadata: {
        source: "sam2_mask" as const,
        parentAssetId: "asset-1",
        parentClipId: "clip-1",
        maskClipId: "clip-1::mask::mask-1",
        pointCount: 2,
        sourceHash: "source-hash-1",
      },
    },
    {
      label: "brush",
      creationMetadata: {
        source: "brush_mask" as const,
        parentClipId: "clip-1",
        maskClipId: "clip-1::mask::mask-1",
      },
    },
    {
      label: "generation",
      creationMetadata: {
        source: "generation_mask" as const,
        parentGeneratedAssetId: "generated-1",
      },
    },
  ])(
    "stores new $label mask sources under .vloproject/masks",
    async ({ creationMetadata }) => {
      const file = new File(["mask"], "mask.png", { type: "image/png" });

      (mediaProcessingService.computeChecksum as Mock).mockResolvedValue(
        `hash-${creationMetadata.source}`,
      );
      (mediaProcessingService.generateImageThumbnail as Mock).mockResolvedValue(
        null,
      );

      const asset = await assetService.ingestAsset(
        file,
        false,
        true,
        [],
        creationMetadata,
      );

      expect(asset).toMatchObject({
        name: "mask.png",
        type: "image",
        sourcePath: ".vloproject/masks/mask.png",
      });

      await assetService.waitForAssetPersistence(asset!.id);

      expect(fileSystemService.saveAssetFile).toHaveBeenCalledWith(
        file,
        ".vloproject/masks/mask.png",
      );
    },
  );

  it("keeps non-mask uploads at the project root", async () => {
    const file = new File(["image"], "poster.png", { type: "image/png" });

    (mediaProcessingService.computeChecksum as Mock).mockResolvedValue(
      "upload-hash",
    );
    (mediaProcessingService.generateImageThumbnail as Mock).mockResolvedValue(
      null,
    );

    const asset = await assetService.ingestAsset(
      file,
      false,
      true,
      [],
      {
        source: "uploaded",
      },
    );

    expect(asset).toMatchObject({
      name: "poster.png",
      type: "image",
      sourcePath: "poster.png",
    });

    await assetService.waitForAssetPersistence(asset!.id);

    expect(fileSystemService.saveAssetFile).toHaveBeenCalledWith(
      file,
      "poster.png",
    );
  });

  it("creates a fresh generation mask when the matching hash belongs to a non-mask asset", async () => {
    const maskFile = new File(["mask"], "generation-mask.mp4", {
      type: "video/mp4",
    });

    (mediaProcessingService.computeChecksum as Mock).mockResolvedValue(
      "shared-hash",
    );
    mockProcessor.generateVideoMetadata.mockResolvedValue({
      duration: 10,
      thumbnail: null,
      fps: 16,
    });
    mockProcessor.generateProxyVideo.mockResolvedValue(null);

    const newAsset = await assetService.ingestAsset(
      maskFile,
      true,
      true,
      [
        {
          id: "existing-upload",
          name: "user-upload.mp4",
          hash: "shared-hash",
          src: "user-upload.mp4",
          type: "video",
          createdAt: 1,
        },
      ],
      {
        source: "generation_mask",
        parentGeneratedAssetId: "generated-2",
      },
    );

    expect(newAsset).toMatchObject({
      name: "generation-mask.mp4",
      hash: "shared-hash",
      type: "video",
      creationMetadata: {
        source: "generation_mask",
        parentGeneratedAssetId: "generated-2",
      },
    });
  });

  it("ingests a new asset with a suffixed name when the filename already exists but the hash differs", async () => {
    const file = new File(["image"], "duplicate-name.png", {
      type: "image/png",
    });

    (mediaProcessingService.computeChecksum as Mock).mockResolvedValue(
      "new-hash",
    );
    (mediaProcessingService.generateImageThumbnail as Mock).mockResolvedValue(
      new Blob(["thumb"]),
    );

    const newAsset = await assetService.ingestAsset(
      file,
      true,
      true,
      [
        {
          id: "existing-asset",
          name: "duplicate-name.png",
          hash: "existing-hash",
          src: "duplicate-name.png",
          type: "image",
          createdAt: 1,
        },
      ],
      {
        source: "uploaded",
      },
    );

    expect(newAsset).toMatchObject({
      name: "duplicate-name_2.png",
      hash: "new-hash",
      type: "image",
      thumbnailPath: ".vloproject/thumbnails/duplicate-name_2.png_thumb.webp",
    });
  });

  it("uses the collision-resolved asset name for video thumbnail and proxy paths", async () => {
    const file = new File(["video"], "duplicate-video.mp4", {
      type: "video/mp4",
    });

    (mediaProcessingService.computeChecksum as Mock).mockResolvedValue(
      "video-hash-2",
    );
    mockProcessor.generateVideoMetadata.mockResolvedValue({
      duration: 12,
      thumbnail: new Blob(["thumb"]),
      fps: 24,
    });
    mockProcessor.generateProxyVideo.mockResolvedValue(new Blob(["proxy"]));
    mockProcessor.hasAudioTrack.mockResolvedValue(true);

    const newAsset = await assetService.ingestAsset(
      file,
      true,
      true,
      [
        {
          id: "existing-video",
          name: "duplicate-video.mp4",
          hash: "video-hash-1",
          src: "duplicate-video.mp4",
          type: "video",
          createdAt: 1,
        },
      ],
      {
        source: "generated",
        workflowName: "Test Workflow",
        inputs: [],
      },
    );

    expect(newAsset).toMatchObject({
      name: "duplicate-video_2.mp4",
      hash: "video-hash-2",
      type: "video",
      thumbnailPath:
        ".vloproject/thumbnails/duplicate-video_2.mp4_thumb.webp",
      proxyPath: ".vloproject/proxies/duplicate-video_2.mp4_proxy.mp4",
    });
  });
});
