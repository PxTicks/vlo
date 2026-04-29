import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { useAssetStore } from "../useAssetStore";
import { fileSystemService } from "../../project/services/FileSystemService";
import { projectPersistenceService } from "../../project/services/ProjectPersistenceService";

const { mockRemoveClipsByAssetId } = vi.hoisted(() => ({
  mockRemoveClipsByAssetId: vi.fn(),
}));

// Mock dependencies
vi.mock("../../project/services/FileSystemService", () => ({
  fileSystemService: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
  },
}));

// Mock project store to provide root handle presence if needed
vi.mock("../../project/useProjectStore", () => ({
  useProjectStore: {
    getState: vi.fn().mockReturnValue({ rootHandle: {} }),
  },
}));

vi.mock("../../timeline/useTimelineStore", () => ({
  useTimelineStore: {
    getState: () => ({
      removeClipsByAssetId: mockRemoveClipsByAssetId,
    }),
  },
}));

vi.mock("../../timeline", () => ({
  useTimelineStore: {
    getState: () => ({
      removeClipsByAssetId: mockRemoveClipsByAssetId,
    }),
  },
}));

if (globalThis.URL) {
  globalThis.URL.revokeObjectURL = vi.fn();
}

describe("useAssetStore - Deletion", () => {
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
    useAssetStore.setState({
      assets: [
        {
          id: "asset-1",
          name: "video.mp4",
          src: "video.mp4",
          type: "video",
          hash: "123",
          createdAt: 1000,
        },
        {
          id: "asset-2",
          name: "image.png",
          src: "image.png",
          type: "image",
          hash: "456",
          createdAt: 2000,
        },
      ],
      families: [],
      isUploading: false,
      inputCache: new Map(),
    });
    vi.clearAllMocks();
    mockRemoveClipsByAssetId.mockReset();
    projectPersistenceService.resetCaches();
  });

  it("should delete an asset from store, file system, and assets.json", async () => {
    // Arrange: Mock reading assets.json
    const initialAssetIndex = makeAssetIndex({
        "asset-1": {
          id: "asset-1",
          name: "video.mp4",
          hash: "123",
          src: "video.mp4",
          type: "video",
          thumbnail: ".vloproject/thumbnails/video.mp4_thumb.webp",
          createdAt: 1000,
        },
        "asset-2": {
          id: "asset-2",
          name: "image.png",
          hash: "456",
          src: "image.png",
          type: "image",
          createdAt: 2000,
        },
    });
    (fileSystemService.readFile as Mock).mockResolvedValue({
      text: async () => initialAssetIndex,
    });

    // Act
    await useAssetStore.getState().deleteAsset("asset-1");

    // Assert: Memory State
    const { assets } = useAssetStore.getState();
    expect(assets).toHaveLength(1);
    expect(assets.find((a) => a.id === "asset-1")).toBeUndefined();
    expect(assets.find((a) => a.id === "asset-2")).toBeDefined();

    // Assert: File System Deletion
    expect(mockRemoveClipsByAssetId).toHaveBeenCalledWith("asset-1");
    expect(fileSystemService.deleteFile).toHaveBeenCalledWith("video.mp4");
    // Should also attempt to delete thumbnail
    expect(fileSystemService.deleteFile).toHaveBeenCalledWith(
      ".vloproject/thumbnails/video.mp4_thumb.webp",
    );

    // Assert: assets.json Update
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/assets.json",
      expect.stringContaining('"asset-2"'),
    );
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/assets.json",
      expect.not.stringContaining('"asset-1"'),
    );
  });

  it("should handle deletion gracefully if assets.json read fails", async () => {
    // Arrange
    (fileSystemService.readFile as Mock).mockRejectedValue(
      new Error("Read Error"),
    );

    // Act
    await useAssetStore.getState().deleteAsset("asset-1");

    // Assert
    expect(useAssetStore.getState().assets).toHaveLength(1); // Should still remove from memory
    expect(mockRemoveClipsByAssetId).toHaveBeenCalledWith("asset-1");
    expect(fileSystemService.deleteFile).not.toHaveBeenCalled(); // Cannot delete files if we don't know paths
  });

  it("keeps a shared generation mask asset while another generated asset still consumes it", async () => {
    useAssetStore.setState({
      assets: [
        {
          id: "generated-1",
          name: "generated-1.mp4",
          src: "generated-1.mp4",
          type: "video",
          hash: "generated-hash-1",
          createdAt: 1000,
          creationMetadata: {
            source: "generated",
            workflowName: "Workflow",
            inputs: [],
            generationMaskAssetId: "mask-1",
          },
        },
        {
          id: "generated-2",
          name: "generated-2.mp4",
          src: "generated-2.mp4",
          type: "video",
          hash: "generated-hash-2",
          createdAt: 2000,
          creationMetadata: {
            source: "generated",
            workflowName: "Workflow",
            inputs: [],
            generationMaskAssetId: "mask-1",
          },
        },
        {
          id: "mask-1",
          name: "generation-mask-1.mp4",
          src: "mask-1.mp4",
          type: "video",
          hash: "mask-hash-1",
          createdAt: 3000,
          creationMetadata: {
            source: "generation_mask",
            parentGeneratedAssetId: "generated-1",
          },
        },
      ],
      isUploading: false,
    });
    (fileSystemService.readFile as Mock).mockResolvedValue({
      text: async () =>
        makeAssetIndex({
            "generated-1": {
              id: "generated-1",
              name: "generated-1.mp4",
              hash: "generated-hash-1",
              src: "generated-1.mp4",
              type: "video",
              createdAt: 1000,
            },
            "generated-2": {
              id: "generated-2",
              name: "generated-2.mp4",
              hash: "generated-hash-2",
              src: "generated-2.mp4",
              type: "video",
              createdAt: 2000,
            },
            "mask-1": {
              id: "mask-1",
              name: "generation-mask-1.mp4",
              hash: "mask-hash-1",
              src: "mask-1.mp4",
              type: "video",
              createdAt: 3000,
            },
        }),
    });

    await useAssetStore.getState().deleteAsset("generated-1");

    expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual([
      "generated-2",
      "mask-1",
    ]);
    expect(mockRemoveClipsByAssetId).toHaveBeenCalledTimes(1);
    expect(mockRemoveClipsByAssetId).toHaveBeenCalledWith("generated-1");
    expect(fileSystemService.deleteFile).toHaveBeenCalledWith("generated-1.mp4");
    expect(fileSystemService.deleteFile).not.toHaveBeenCalledWith("mask-1.mp4");
    expect(fileSystemService.writeFile).toHaveBeenLastCalledWith(
      ".vloproject/assets.json",
      expect.stringContaining('"mask-1"'),
    );
  });

  it("refuses to delete a generation mask asset while generated assets still reference it", async () => {
    useAssetStore.setState({
      assets: [
        {
          id: "generated-1",
          name: "generated-1.mp4",
          src: "generated-1.mp4",
          type: "video",
          hash: "generated-hash-1",
          createdAt: 1000,
          creationMetadata: {
            source: "generated",
            workflowName: "Workflow",
            inputs: [],
            generationMaskAssetId: "mask-1",
          },
        },
        {
          id: "mask-1",
          name: "generation-mask-1.mp4",
          src: "mask-1.mp4",
          type: "video",
          hash: "mask-hash-1",
          createdAt: 3000,
          creationMetadata: {
            source: "generation_mask",
            parentGeneratedAssetId: "generated-1",
          },
        },
      ],
      isUploading: false,
    });

    await useAssetStore.getState().deleteAsset("mask-1");

    expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual([
      "generated-1",
      "mask-1",
    ]);
    expect(mockRemoveClipsByAssetId).not.toHaveBeenCalled();
    expect(fileSystemService.writeFile).not.toHaveBeenCalled();
    expect(fileSystemService.deleteFile).not.toHaveBeenCalled();
  });

  it("deletes a shared generation mask asset after the final generated consumer is removed", async () => {
    useAssetStore.setState({
      assets: [
        {
          id: "generated-1",
          name: "generated-1.mp4",
          src: "generated-1.mp4",
          type: "video",
          hash: "generated-hash-1",
          createdAt: 1000,
          creationMetadata: {
            source: "generated",
            workflowName: "Workflow",
            inputs: [],
            generationMaskAssetId: "mask-1",
          },
        },
        {
          id: "generated-2",
          name: "generated-2.mp4",
          src: "generated-2.mp4",
          type: "video",
          hash: "generated-hash-2",
          createdAt: 2000,
          creationMetadata: {
            source: "generated",
            workflowName: "Workflow",
            inputs: [],
            generationMaskAssetId: "mask-1",
          },
        },
        {
          id: "mask-1",
          name: "generation-mask-1.mp4",
          src: "mask-1.mp4",
          type: "video",
          hash: "mask-hash-1",
          createdAt: 3000,
          creationMetadata: {
            source: "generation_mask",
            parentGeneratedAssetId: "generated-1",
          },
        },
      ],
      families: [],
      isUploading: false,
    });
    (fileSystemService.readFile as Mock).mockResolvedValue({
      text: async () =>
        makeAssetIndex({
            "generated-1": {
              id: "generated-1",
              name: "generated-1.mp4",
              hash: "generated-hash-1",
              src: "generated-1.mp4",
              type: "video",
              createdAt: 1000,
            },
            "generated-2": {
              id: "generated-2",
              name: "generated-2.mp4",
              hash: "generated-hash-2",
              src: "generated-2.mp4",
              type: "video",
              createdAt: 2000,
            },
            "mask-1": {
              id: "mask-1",
              name: "generation-mask-1.mp4",
              hash: "mask-hash-1",
              src: "mask-1.mp4",
              type: "video",
              createdAt: 3000,
            },
        }),
    });

    await useAssetStore.getState().deleteAsset("generated-1");
    await useAssetStore.getState().deleteAsset("generated-2");

    expect(useAssetStore.getState().assets).toHaveLength(0);
    expect(fileSystemService.deleteFile).toHaveBeenCalledWith("generated-2.mp4");
    expect(fileSystemService.deleteFile).toHaveBeenCalledWith("mask-1.mp4");
    expect(mockRemoveClipsByAssetId).toHaveBeenCalledWith("mask-1");
    expect(fileSystemService.writeFile).toHaveBeenLastCalledWith(
      ".vloproject/assets.json",
      expect.not.stringContaining('"mask-1"'),
    );
  });

  it("reassigns the representative when the current family representative is deleted", async () => {
    useAssetStore.setState({
      assets: [
        {
          id: "asset-1",
          name: "video-a.mp4",
          src: "video-a.mp4",
          type: "video",
          hash: "hash-a",
          familyId: "family-1",
          duration: 5,
          fps: 24,
          createdAt: 1000,
        },
        {
          id: "asset-2",
          name: "video-b.mp4",
          src: "video-b.mp4",
          type: "video",
          hash: "hash-b",
          familyId: "family-1",
          duration: 5,
          fps: 24,
          createdAt: 2000,
        },
      ],
      families: [
        {
          id: "family-1",
          representativeAssetId: "asset-2",
          autoMatchKeys: ["generation-family:v1:match"],
          compatibility: {
            assetType: "video",
            durationMs: 5000,
            fpsMilli: 24000,
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      isUploading: false,
    });
    (fileSystemService.readFile as Mock).mockResolvedValue({
      text: async () =>
        makeAssetIndex(
          {
            "asset-1": {
              id: "asset-1",
              name: "video-a.mp4",
              hash: "hash-a",
              src: "video-a.mp4",
              type: "video",
              createdAt: 1000,
            },
            "asset-2": {
              id: "asset-2",
              name: "video-b.mp4",
              hash: "hash-b",
              src: "video-b.mp4",
              type: "video",
              createdAt: 2000,
            },
          },
          {
            "family-1": {
              id: "family-1",
              representativeAssetId: "asset-2",
              compatibility: {
                assetType: "video",
                durationMs: 5000,
                fpsMilli: 24000,
              },
              createdAt: 1,
              updatedAt: 1,
            },
          },
        ),
    });

    await useAssetStore.getState().deleteAsset("asset-2");

    expect(useAssetStore.getState().families).toEqual([
      expect.objectContaining({
        id: "family-1",
        representativeAssetId: "asset-1",
      }),
    ]);
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/assets.json",
      expect.stringContaining('"representativeAssetId": "asset-1"'),
    );
  });

  it("removes empty families when their final member is deleted", async () => {
    useAssetStore.setState({
      assets: [
        {
          id: "asset-1",
          name: "video-a.mp4",
          src: "video-a.mp4",
          type: "video",
          hash: "hash-a",
          familyId: "family-1",
          duration: 5,
          fps: 24,
          createdAt: 1000,
        },
      ],
      families: [
        {
          id: "family-1",
          representativeAssetId: "asset-1",
          autoMatchKeys: ["generation-family:v1:match"],
          compatibility: {
            assetType: "video",
            durationMs: 5000,
            fpsMilli: 24000,
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      isUploading: false,
    });
    (fileSystemService.readFile as Mock).mockResolvedValue({
      text: async () =>
        makeAssetIndex(
          {
            "asset-1": {
              id: "asset-1",
              name: "video-a.mp4",
              hash: "hash-a",
              src: "video-a.mp4",
              type: "video",
              createdAt: 1000,
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
        ),
    });

    await useAssetStore.getState().deleteAsset("asset-1");

    expect(useAssetStore.getState().families).toEqual([]);
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/assets.json",
      expect.stringContaining('"assetFamilies": {}'),
    );
  });
});
