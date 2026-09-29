import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockDirectoryHandle,
  createMockFileHandle,
} from "../../../testUtils/fileSystem";
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

  it("opens the native video save picker with MP4 defaults", async () => {
    const handle = createMockFileHandle("render.mp4");
    const showSaveFilePicker = vi.fn().mockResolvedValue(handle);
    vi.stubGlobal("window", {
      ...globalThis.window,
      showSaveFilePicker,
    });

    const service = new FileSystemService();
    await expect(service.showSaveVideoPicker("cut.mp4")).resolves.toBe(handle);
    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: "cut.mp4",
      startIn: "videos",
      types: [
        {
          description: "MP4 video",
          accept: { "video/mp4": [".mp4"] },
        },
      ],
    });
  });

  it("configures the native picker for WebM exports", async () => {
    const handle = createMockFileHandle("render.webm");
    const showSaveFilePicker = vi.fn().mockResolvedValue(handle);
    vi.stubGlobal("window", {
      ...globalThis.window,
      showSaveFilePicker,
    });

    const service = new FileSystemService();
    await expect(
      service.showSaveVideoPicker("cut.webm", "webm"),
    ).resolves.toBe(handle);
    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: "cut.webm",
      startIn: "videos",
      types: [
        {
          description: "WebM video",
          accept: { "video/webm": [".webm"] },
        },
      ],
    });
  });

  it("checks whether child directories exist", async () => {
    const parent = createMockDirectoryHandle();
    parent.getDirectoryHandle
      .mockResolvedValueOnce(createMockDirectoryHandle("assets"))
      .mockRejectedValueOnce(
        new DOMException("missing", "NotFoundError"),
      )
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    const service = new FileSystemService();

    await expect(service.checkDirectoryExists(parent, "assets")).resolves.toBe(
      true,
    );
    await expect(service.checkDirectoryExists(parent, "missing")).resolves.toBe(
      false,
    );
    await expect(service.checkDirectoryExists(parent, "private")).rejects.toThrow(
      "denied",
    );
  });

  it("checks and requests read or readwrite permissions", async () => {
    const granted = createMockDirectoryHandle("granted");
    const requested = createMockDirectoryHandle("requested", {
      permission: "prompt",
    });
    requested.requestPermission.mockResolvedValue("granted");
    const denied = createMockDirectoryHandle("denied", {
      permission: "denied",
    });
    const service = new FileSystemService();

    await expect(service.verifyPermission(granted)).resolves.toBe(true);
    expect(granted.queryPermission).toHaveBeenCalledWith({ mode: "read" });
    expect(granted.requestPermission).not.toHaveBeenCalled();

    await expect(service.verifyPermission(requested, true)).resolves.toBe(true);
    expect(requested.requestPermission).toHaveBeenCalledWith({
      mode: "readwrite",
    });
    await expect(service.verifyPermission(denied)).resolves.toBe(false);
  });

  it("requires an open project for project-relative operations", async () => {
    const service = new FileSystemService();

    await expect(service.readFile("project.json")).rejects.toThrow(
      "No project open",
    );
    await expect(service.writeFile("project.json", "{}")).rejects.toThrow(
      "No project open",
    );
    await expect(service.removeEntry("project.json")).rejects.toThrow(
      "No project open",
    );
    await expect(service.renameFile("old", "new")).rejects.toThrow(
      "No project open",
    );
    await expect(service.listDirectory("assets")).rejects.toThrow(
      "No project open",
    );
  });

  it("reads nested files without creating directories", async () => {
    const project = createMockDirectoryHandle();
    const assets = createMockDirectoryHandle("assets");
    const file = new File(["content"], "clip.mp4");
    const fileHandle = createMockFileHandle("clip.mp4", file);
    project.getDirectoryHandle.mockResolvedValue(assets);
    assets.getFileHandle.mockResolvedValue(fileHandle);
    const service = new FileSystemService();
    service.setHandle(project);

    await expect(service.readFile("assets/clip.mp4")).resolves.toBe(file);
    expect(project.getDirectoryHandle).toHaveBeenCalledWith("assets", {
      create: false,
    });
    expect(assets.getFileHandle).toHaveBeenCalledWith("clip.mp4", {
      create: false,
    });
  });

  it("detects existing, missing, and unexpected file errors", async () => {
    const service = new FileSystemService();
    const readSpy = vi.spyOn(service, "readFile");
    readSpy
      .mockResolvedValueOnce(new File([], "exists"))
      .mockRejectedValueOnce(new DOMException("gone", "NotFoundError"))
      .mockRejectedValueOnce(new Error("asset missing"))
      .mockRejectedValueOnce(new Error("permission denied"));

    await expect(service.fileExists("exists")).resolves.toBe(true);
    await expect(service.fileExists("gone")).resolves.toBe(false);
    await expect(service.fileExists("missing")).resolves.toBe(false);
    await expect(service.fileExists("private")).rejects.toThrow(
      "permission denied",
    );
  });

  it("creates nested directories and writes then closes files", async () => {
    const project = createMockDirectoryHandle();
    const assets = createMockDirectoryHandle("assets");
    const thumbnails = createMockDirectoryHandle("thumbnails");
    const fileHandle = createMockFileHandle("thumb.jpg");
    project.getDirectoryHandle.mockResolvedValue(assets);
    assets.getDirectoryHandle.mockResolvedValue(thumbnails);
    thumbnails.getFileHandle.mockResolvedValue(fileHandle);
    const service = new FileSystemService();
    service.setHandle(project);

    const blob = new Blob(["image"]);
    await service.writeFile("assets/thumbnails/thumb.jpg", blob);
    const writable = await fileHandle.createWritable.mock.results[0].value;
    expect(project.getDirectoryHandle).toHaveBeenCalledWith("assets", {
      create: true,
    });
    expect(assets.getDirectoryHandle).toHaveBeenCalledWith("thumbnails", {
      create: true,
    });
    expect(writable.write).toHaveBeenCalledWith(blob);
    expect(writable.close).toHaveBeenCalled();
  });

  it("delegates asset saves and file deletion", async () => {
    const service = new FileSystemService();
    const writeSpy = vi.spyOn(service, "writeFile").mockResolvedValue();
    const removeSpy = vi.spyOn(service, "removeEntry").mockResolvedValue();
    const file = new File(["asset"], "asset.mp4");

    await service.saveAssetFile(file, "assets/asset.mp4");
    await service.deleteFile("assets/asset.mp4");
    expect(writeSpy).toHaveBeenCalledWith("assets/asset.mp4", file);
    expect(removeSpy).toHaveBeenCalledWith("assets/asset.mp4");
  });

  it("removes nested entries and tolerates already-missing entries", async () => {
    const project = createMockDirectoryHandle();
    const assets = createMockDirectoryHandle("assets");
    project.getDirectoryHandle.mockResolvedValueOnce(assets);
    const service = new FileSystemService();
    service.setHandle(project);

    await service.removeEntry("assets/cache", { recursive: true });
    expect(assets.removeEntry).toHaveBeenCalledWith("cache", {
      recursive: true,
    });

    project.getDirectoryHandle.mockRejectedValueOnce(
      new DOMException("missing", "NotFoundError"),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(service.removeEntry("missing/file")).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalled();

    project.getDirectoryHandle.mockRejectedValueOnce(
      new DOMException("denied", "NotAllowedError"),
    );
    await expect(service.removeEntry("private/file")).rejects.toThrow("denied");
  });

  it("renames files by reading, writing, and deleting", async () => {
    const service = new FileSystemService();
    service.setHandle(createMockDirectoryHandle());
    const file = new File(["old"], "old.txt");
    const readSpy = vi.spyOn(service, "readFile").mockResolvedValue(file);
    const writeSpy = vi.spyOn(service, "writeFile").mockResolvedValue();
    const deleteSpy = vi.spyOn(service, "deleteFile").mockResolvedValue();

    await service.renameFile("old.txt", "new.txt");
    expect(readSpy).toHaveBeenCalledWith("old.txt");
    expect(writeSpy).toHaveBeenCalledWith("new.txt", file);
    expect(deleteSpy).toHaveBeenCalledWith("old.txt");
  });

  it("logs and rethrows rename failures", async () => {
    const service = new FileSystemService();
    service.setHandle(createMockDirectoryHandle());
    vi.spyOn(service, "readFile").mockRejectedValue(new Error("read failed"));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(service.renameFile("old", "new")).rejects.toThrow(
      "read failed",
    );
    expect(errorSpy).toHaveBeenCalled();
  });

  it("lists files at root and nested paths while ignoring directories", async () => {
    const nestedFile = createMockFileHandle("one.mp4");
    const childDirectory = createMockDirectoryHandle("nested");
    const assets = createMockDirectoryHandle("assets", {
      entries: [
        ["one.mp4", nestedFile],
        ["nested", childDirectory],
      ],
    });
    const root = createMockDirectoryHandle("root", {
      entries: [["root.txt", createMockFileHandle("root.txt")]],
    });
    root.getDirectoryHandle.mockResolvedValue(assets);
    const service = new FileSystemService();
    service.setHandle(root);

    await expect(service.listDirectory(".")).resolves.toEqual(["root.txt"]);
    await expect(service.listDirectory("/")).resolves.toEqual(["root.txt"]);
    await expect(service.listDirectory("assets")).resolves.toEqual([
      "one.mp4",
    ]);

    root.getDirectoryHandle.mockRejectedValueOnce(new Error("missing"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(service.listDirectory("missing")).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });
});
