import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { useAssetStore } from "../useAssetStore";
import { fileSystemService } from "../../project/services/FileSystemService";
import { projectDocumentService } from "../../project/services/ProjectDocumentService";

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

describe("useAssetStore - Deletion", () => {
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
      isUploading: false,
    });
    vi.clearAllMocks();
    mockRemoveClipsByAssetId.mockReset();
    projectDocumentService.resetProjectDocumentCache();
  });

  it("should delete an asset from store, file system, and project.json", async () => {
    // Arrange: Mock reading project.json
    const initialProjectData = {
      assets: {
        "asset-1": {
          id: "asset-1",
          name: "video.mp4",
          src: "video.mp4",
          thumbnail: ".vloproject/thumbnails/video.mp4_thumb.webp",
        },
        "asset-2": { id: "asset-2", name: "image.png", src: "image.png" },
      },
    };
    (fileSystemService.readFile as Mock).mockResolvedValue({
      text: async () => JSON.stringify(initialProjectData),
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

    // Assert: Project JSON Update
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/project.json",
      expect.stringContaining('"asset-2"'),
    );
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/project.json",
      expect.not.stringContaining('"asset-1"'),
    );
  });

  it("should handle deletion gracefully if project.json read fails", async () => {
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
});
