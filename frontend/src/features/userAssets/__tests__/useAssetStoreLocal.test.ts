import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useAssetStore } from "../useAssetStore";
import type { MediaFileProcessor } from "../services/MediaProcessingService";

// import { useProjectStore } from '../../project/useProjectStore';

// Mock dependencies
const { mockCanvases } = vi.hoisted(() => {
  return {
    mockCanvases: {
      next: vi.fn(),
      return: vi.fn(),
      [Symbol.asyncIterator]: vi.fn(),
    },
  };
});

// Mock dependencies
vi.mock("mediabunny", () => {
  const mockCanvasSink = {
    canvases: vi.fn(() => mockCanvases),
  };
  const mockInput = vi.fn(() => ({
    computeDuration: vi.fn().mockResolvedValue(10), // 10 seconds
    getPrimaryVideoTrack: vi.fn().mockResolvedValue({}),
    dispose: vi.fn(),
  }));

  return {
    Input: mockInput,
    UrlSource: vi.fn(),
    BlobSource: vi.fn(),
    CanvasSink: vi.fn().mockImplementation(() => mockCanvasSink),
    ALL_FORMATS: [],
  };
});

vi.mock("../../project/services/FileSystemService", () => ({
  fileSystemService: {
    saveAssetFile: vi.fn(),
    readFile: vi
      .fn()
      .mockResolvedValue(new File(["{}"], "project.json", { type: "application/json" })),
    writeFile: vi.fn(),
  },
}));

vi.mock("../services/MediaProcessingService", () => ({
  mediaProcessingService: {
    computeChecksum: vi.fn().mockResolvedValue("mock-hash"),
    computeDuration: vi.fn().mockResolvedValue(10),
    sanitizeFilename: vi.fn((name) => name),
    generateVideoMetadata: vi
      .fn()
      .mockResolvedValue({ duration: 10, thumbnail: null, fps: 30 }),
    generateImageThumbnail: vi.fn().mockResolvedValue(new Blob([])),
    createProcessor: vi.fn(() => ({
      detectMimeType: vi.fn(),
      computeDuration: vi.fn().mockResolvedValue(10),
      generateVideoMetadata: vi
        .fn()
        .mockResolvedValue({ duration: 10, thumbnail: null, fps: 30 }),
      generateProxyVideo: vi.fn(),
      hasAudioTrack: vi.fn().mockResolvedValue(true),
      dispose: vi.fn(),
    })),
  },
}));

describe("useAssetStore - Local Assets", () => {
  beforeEach(() => {
    useAssetStore.setState({
      assets: [],
      isUploading: false,
      uploadingCount: 0,
      isLoading: false,
      inputCache: new Map(),
    });

    // Mock URL.createObjectURL using vi.stubGlobal (cleaner than global.URL assignment)
    // Mock URL.createObjectURL
    // We modify the existing URL object instead of replacing it to ensure new URL() still works if needed
    if (globalThis.URL) {
      globalThis.URL.createObjectURL = vi.fn(
        () => "blob:http://localhost:3000/uuid",
      );
      globalThis.URL.revokeObjectURL = vi.fn();
    } else {
      vi.stubGlobal(
        "URL",
        class {
          static createObjectURL = vi.fn(
            () => "blob:http://localhost:3000/uuid",
          );
          static revokeObjectURL = vi.fn();
        },
      );
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("addLocalAsset adds a file to the store with the correct structure", async () => {
    const file = new File(["content"], "test-video.mp4", { type: "video/mp4" });
    const store = useAssetStore.getState();

    await store.addLocalAsset(file);

    const updatedAssets = useAssetStore.getState().assets;
    expect(updatedAssets).toHaveLength(1);

    const asset = updatedAssets[0];
    expect(asset.name).toBe("test-video.mp4");
    expect(asset.type).toBe("video");
    expect(asset.file).toBe(file);
    expect(asset.src).toBe("blob:http://localhost:3000/uuid");
    expect(URL.createObjectURL).toHaveBeenCalledWith(file);
  });

  it("addLocalAsset detects images correctly", async () => {
    const file = new File(["img"], "test-image.png", { type: "image/png" });
    const store = useAssetStore.getState();

    await store.addLocalAsset(file);

    const updatedAssets = useAssetStore.getState().assets;
    expect(updatedAssets[0].type).toBe("image");
  });

  it("addLocalAssets batches files and resets upload state after ingest", async () => {
    const { mediaProcessingService } =
      await import("../services/MediaProcessingService");

    vi.mocked(mediaProcessingService.computeChecksum)
      .mockResolvedValueOnce("video-hash")
      .mockResolvedValueOnce("image-hash");

    const store = useAssetStore.getState();
    const videoFile = new File(["video"], "clip.mp4", { type: "video/mp4" });
    const imageFile = new File(["image"], "poster.png", {
      type: "image/png",
    });

    const uploadPromise = store.addLocalAssets([videoFile, imageFile]);

    expect(useAssetStore.getState().isUploading).toBe(true);
    expect(useAssetStore.getState().uploadingCount).toBe(1);

    const newAssets = await uploadPromise;

    expect(newAssets).toHaveLength(2);
    expect(newAssets.map((asset) => asset.type)).toEqual(["video", "image"]);
    expect(useAssetStore.getState().isUploading).toBe(false);
    expect(useAssetStore.getState().uploadingCount).toBe(0);
  });

  it("addLocalAsset updates video metadata asynchronously", async () => {
    const { mediaProcessingService } =
      await import("../services/MediaProcessingService");

    vi.mocked(mediaProcessingService.createProcessor).mockImplementation(
      () =>
        ({
          detectMimeType: vi.fn(),
          computeDuration: vi.fn().mockResolvedValue(10),
          generateVideoMetadata: vi.fn().mockResolvedValue({
            duration: 10,
            thumbnail: new Blob(["thumb"], { type: "image/jpeg" }),
            fps: 30,
          }),
          generateProxyVideo: vi.fn(),
          hasAudioTrack: vi.fn().mockResolvedValue(true),
          dispose: vi.fn(),
        }) as unknown as MediaFileProcessor,
    );

    // Setup URL.createObjectURL to return data url for test convenience (or spy)
    // Actually useAssetStore converts blob to objectURL.
    // So we expect blob:url.

    const file = new File(["video"], "test.mp4", { type: "video/mp4" });
    const store = useAssetStore.getState();

    await store.addLocalAsset(file);

    // Wait for async updates (Zustand updates are synchronous but the promise chain in addLocalAsset needs to resolve)
    // Since we await addLocalAsset, it should be done.

    const updatedAssets = useAssetStore.getState().assets;
    const asset = updatedAssets[0];

    expect(asset.duration).toBe(10); // 10 seconds
    expect(asset.fps).toBe(30);
    expect(asset.thumbnail).toEqual(expect.stringContaining("blob:"));
  });
});
