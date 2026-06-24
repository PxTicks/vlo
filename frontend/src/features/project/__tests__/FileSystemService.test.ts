import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemService } from "../services/FileSystemService";

describe("FileSystemService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests readwrite access when picking a directory", async () => {
    const handle = { name: "Project" } as FileSystemDirectoryHandle;
    const showDirectoryPicker = vi.fn().mockResolvedValue(handle);

    vi.stubGlobal("window", {
      ...globalThis.window,
      showDirectoryPicker,
    });

    const service = new FileSystemService();

    await expect(
      service.pickDirectory({
        id: "vlo-project",
        startIn: "videos",
      }),
    ).resolves.toBe(handle);

    expect(showDirectoryPicker).toHaveBeenCalledWith({
      id: "vlo-project",
      startIn: "videos",
      mode: "readwrite",
    });
  });

  it("stores the selected handle when opening a directory", async () => {
    const handle = { name: "Project" } as FileSystemDirectoryHandle;
    const service = new FileSystemService();
    const pickDirectorySpy = vi
      .spyOn(service, "pickDirectory")
      .mockResolvedValue(handle);

    await expect(service.openDirectory()).resolves.toBe(handle);

    expect(pickDirectorySpy).toHaveBeenCalledOnce();
    expect(service.getHandle()).toBe(handle);
  });
});
