import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// Hoist the mock object so it is available in the mock factory
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    put: vi.fn(),
    getAll: vi.fn(),
    delete: vi.fn(),
    createObjectStore: vi.fn(),
  },
}));

// Mock idb before import
vi.mock("idb", () => ({
  openDB: vi.fn().mockResolvedValue(mockDb),
}));

import { recentProjectsService } from "../services/RecentProjectsService";

describe("RecentProjectsService", () => {
  const mockHandleA = {
    name: "ProjectA",
    kind: "directory",
    isSameEntry: vi.fn(),
  } as unknown as FileSystemDirectoryHandle;

  const mockHandleB = {
    name: "ProjectB",
    kind: "directory",
    isSameEntry: vi.fn(),
  } as unknown as FileSystemDirectoryHandle;

  beforeEach(() => {
    vi.clearAllMocks();
    // openDB is called at module load time, so we can't assert on it easily each test
    // but the dbPromise inside the service has resolved to our mockDb
  });

  it("should add a recent project without duplicates", async () => {
    // Arrange
    (mockDb.getAll as Mock).mockResolvedValue([]); 

    // Act
    await recentProjectsService.addRecent("id-1", "ProjectA", mockHandleA);

    // Assert
    expect(mockDb.put).toHaveBeenCalledWith("recentProjects", expect.objectContaining({
      id: "id-1",
      name: "ProjectA",
      handle: mockHandleA,
    }));
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it("should remove stale duplicate entries (different ID, same folder)", async () => {
    // Arrange
    const existingEntry = { id: "old-id", name: "ProjectA", handle: mockHandleA };
    (mockDb.getAll as Mock).mockResolvedValue([existingEntry]);
    
    // When checking against the existing handle, let's say it returns true
    (mockHandleA.isSameEntry as Mock).mockResolvedValue(true);

    // Act
    await recentProjectsService.addRecent("new-id", "ProjectA", mockHandleA);

    // Assert
    expect(mockHandleA.isSameEntry).toHaveBeenCalled();
    expect(mockDb.delete).toHaveBeenCalledWith("recentProjects", "old-id");
    expect(mockDb.put).toHaveBeenCalledWith("recentProjects", expect.objectContaining({
      id: "new-id"
    }));
  });

  it("should not delete if handle is different", async () => {
    // Arrange
    const existingEntry = { id: "other-project", name: "ProjectB", handle: mockHandleB };
    (mockDb.getAll as Mock).mockResolvedValue([existingEntry]);
    
    (mockHandleA.isSameEntry as Mock).mockResolvedValue(false);

    // Act
    await recentProjectsService.addRecent("id-1", "ProjectA", mockHandleA);

    // Assert
    expect(mockDb.delete).not.toHaveBeenCalled();
    expect(mockDb.put).toHaveBeenCalledWith("recentProjects", expect.objectContaining({
        id: "id-1"
    }));
  });
});
