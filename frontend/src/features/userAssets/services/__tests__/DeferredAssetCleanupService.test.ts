import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedAssetIndexEntry } from "../../../project/services/ProjectPersistenceService";

const {
  mockClearTrash,
  mockDeleteTrashItem,
  mockMoveFilesToTrash,
  mockRestoreTrashItem,
} = vi.hoisted(() => ({
  mockClearTrash: vi.fn(),
  mockDeleteTrashItem: vi.fn(),
  mockMoveFilesToTrash: vi.fn(),
  mockRestoreTrashItem: vi.fn(),
}));

vi.mock("../../../project/services/ProjectTrashService", () => ({
  PROJECT_TRASH_LIMIT_BYTES: 300 * 1024 * 1024,
  projectTrashService: {
    clearTrash: mockClearTrash,
    deleteTrashItem: mockDeleteTrashItem,
    moveFilesToTrash: mockMoveFilesToTrash,
    restoreTrashItem: mockRestoreTrashItem,
  },
}));

import { DeferredAssetCleanupService } from "../DeferredAssetCleanupService";

function createEntry(id: string): PersistedAssetIndexEntry {
  return {
    id,
    hash: `${id}-hash`,
    name: `${id}.mp4`,
    type: "video",
    src: `${id}.mp4`,
    createdAt: 1,
  };
}

describe("DeferredAssetCleanupService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClearTrash.mockResolvedValue(undefined);
    mockDeleteTrashItem.mockResolvedValue(undefined);
    mockRestoreTrashItem.mockResolvedValue(undefined);
    mockMoveFilesToTrash.mockImplementation(async () => ({
      id: `trash-${mockMoveFilesToTrash.mock.calls.length}`,
      createdAt: Date.now(),
      sizeBytes: 1,
      files: [],
    }));
  });

  it("serializes defer and restore operations for the same asset", async () => {
    const service = new DeferredAssetCleanupService();
    const entry = createEntry("asset-1");
    let resolveRestore!: () => void;
    const restorePromise = new Promise<void>((resolve) => {
      resolveRestore = resolve;
    });

    await service.deferAssetCleanup(entry, [entry.src]);
    mockRestoreTrashItem.mockImplementationOnce(async () => {
      await restorePromise;
    });

    const restoring = service.restoreAssetCleanup(entry.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockRestoreTrashItem).toHaveBeenCalledTimes(1);

    const deferringAgain = service.deferAssetCleanup(entry, [entry.src]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockMoveFilesToTrash).toHaveBeenCalledTimes(1);

    resolveRestore();
    await restoring;
    await deferringAgain;

    expect(mockMoveFilesToTrash).toHaveBeenCalledTimes(2);
  });
});
