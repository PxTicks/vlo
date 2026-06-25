import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDirectoryHandle } from "../../../testUtils/fileSystem";

const { mockDb, openDB } = vi.hoisted(() => ({
  mockDb: {
    get: vi.fn(),
    put: vi.fn(),
  },
  openDB: vi.fn(),
}));

vi.mock("idb", () => ({
  openDB,
}));

import { NewProjectDirectoryService } from "../services/NewProjectDirectoryService";

describe("NewProjectDirectoryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openDB.mockResolvedValue(mockDb);
  });

  it("restores the selected directory", async () => {
    const handle = createMockDirectoryHandle("Workspace");
    mockDb.get.mockResolvedValue({
      id: "new-project-directory",
      handle,
    });
    const service = new NewProjectDirectoryService();

    await expect(service.getDirectory()).resolves.toBe(handle);
    expect(mockDb.get).toHaveBeenCalledWith(
      "preferences",
      "new-project-directory",
    );
  });

  it("returns null when no directory has been selected", async () => {
    mockDb.get.mockResolvedValue(undefined);
    const service = new NewProjectDirectoryService();

    await expect(service.getDirectory()).resolves.toBeNull();
  });

  it("persists the selected directory handle", async () => {
    const handle = createMockDirectoryHandle("Workspace");
    const service = new NewProjectDirectoryService();

    await service.setDirectory(handle);

    expect(mockDb.put).toHaveBeenCalledWith("preferences", {
      id: "new-project-directory",
      handle,
    });
  });
});
