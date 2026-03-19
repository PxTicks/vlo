/**
 * Service to handle native File System Access API operations.
 * Allows the app to interact with the local disk for project management.
 */

export class FileSystemService {
  private projectHandle: FileSystemDirectoryHandle | null = null;

  constructor() {}

  /**
   * Prompts the user to select a directory with read/write access so the browser
   * doesn't need to re-prompt when we later create files or folders.
   */
  async pickDirectory(
    options: Omit<DirectoryPickerOptions, "mode"> = {},
  ): Promise<FileSystemDirectoryHandle> {
    return await window.showDirectoryPicker({
      ...options,
      mode: "readwrite",
    });
  }

  /**
   * Prompts the user to select a directory to open as a project.
   */
  async openDirectory(): Promise<FileSystemDirectoryHandle> {
    const handle = await this.pickDirectory();
    this.projectHandle = handle;
    return handle;
  }

  /**
   * Prompts the user to select a location to save an exported video.
   */
  async showSaveVideoPicker(
    defaultName: string = "export.mp4",
  ): Promise<FileSystemFileHandle> {
    return await window.showSaveFilePicker({
      suggestedName: defaultName,
      startIn: "videos",
      types: [
        {
          description: "Video files",
          accept: {
            "video/mp4": [".mp4"],
            "video/webm": [".webm"],
          },
        },
      ],
    });
  }

  /**
   * Checks if a directory with the given name exists within the parent handle.
   * Returns true if it exists, false if not found.
   */
  async checkDirectoryExists(
    parentHandle: FileSystemDirectoryHandle,
    name: string,
  ): Promise<boolean> {
    try {
      await parentHandle.getDirectoryHandle(name, { create: false });
      return true;
    } catch (e) {
      if ((e as DOMException).name === "NotFoundError") {
        return false;
      }
      throw e;
    }
  }

  /**
   * Sets the project handle explicitly (e.g., from IndexedDB on reload).
   */
  setHandle(handle: FileSystemDirectoryHandle) {
    this.projectHandle = handle;
  }

  getHandle() {
    return this.projectHandle;
  }

  /**
   * Verifies and requests permission for the handle.
   */
  async verifyPermission(
    handle: FileSystemHandle,
    readWrite: boolean = false,
  ): Promise<boolean> {
    const options: FileSystemHandlePermissionDescriptor = {
      mode: readWrite ? "readwrite" : "read",
    };

    // Check if permission was already granted
    if ((await handle.queryPermission(options)) === "granted") {
      return true;
    }

    // Request permission using the user gesture requirement
    if ((await handle.requestPermission(options)) === "granted") {
      return true;
    }

    return false;
  }

  /**
   * Reads a file from the project root or subdirectories.
   * Path should be relative, e.g., "project.json" or "assets/video.mp4"
   */
  async readFile(path: string): Promise<File> {
    if (!this.projectHandle) throw new Error("No project open");

    const parts = path.split("/");
    const filename = parts.pop()!;
    let currentHandle = this.projectHandle;

    // Navigate subdirectories
    for (const part of parts) {
      currentHandle = await currentHandle.getDirectoryHandle(part, {
        create: false,
      });
    }

    const fileHandle = await currentHandle.getFileHandle(filename, {
      create: false,
    });
    return await fileHandle.getFile(); // Returns a File object (Blob-like)
  }

  /**
   * Writes content to a file in the project.
   * Creates parent directories if they don't exist.
   */
  async writeFile(path: string, content: string | Blob | BufferSource) {
    if (!this.projectHandle) throw new Error("No project open");

    const parts = path.split("/");
    const filename = parts.pop()!;
    let currentHandle = this.projectHandle;

    // Navigate/Create subdirectories
    for (const part of parts) {
      currentHandle = await currentHandle.getDirectoryHandle(part, {
        create: true,
      });
    }

    const fileHandle = await currentHandle.getFileHandle(filename, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  /**
   * Copies a file (from input) to the project assets folder.
   * storagePath: e.g., "assets/my-video.mp4"
   */
  async saveAssetFile(file: File, storagePath: string) {
    await this.writeFile(storagePath, file);
  }

  /**
   * Deletes a file from the project.
   * Silently succeeds if the file doesn't exist (already deleted).
   */
  async deleteFile(path: string) {
    if (!this.projectHandle) throw new Error("No project open");

    const parts = path.split("/");
    const filename = parts.pop()!;
    let currentHandle = this.projectHandle;

    try {
      for (const part of parts) {
        currentHandle = await currentHandle.getDirectoryHandle(part, {
          create: false,
        });
      }

      await currentHandle.removeEntry(filename);
    } catch (e) {
      // If the file or directory doesn't exist, that's fine - it's already gone
      if ((e as DOMException).name === "NotFoundError") {
        console.log(`File already deleted or doesn't exist: ${path}`);
        return;
      }
      // Re-throw other errors (permission denied, etc.)
      throw e;
    }
  }

  /**
   * Renames a file by copying it to the new path and deleting the old one.
   * NOTE: Native 'move' is not yet widely supported in all contexts.
   */
  async renameFile(oldPath: string, newPath: string) {
    if (!this.projectHandle) throw new Error("No project open");

    try {
      // 1. Read source
      const file = await this.readFile(oldPath);

      // 2. Write to new destination
      await this.writeFile(newPath, file);

      // 3. Delete old
      await this.deleteFile(oldPath);
    } catch (e) {
      console.error(`Failed to rename file from ${oldPath} to ${newPath}`, e);
      throw e;
    }
  }

  /**
   * Lists all files (not directories) in a given directory path.
   * Returns an array of filenames.
   */
  async listDirectory(path: string): Promise<string[]> {
    if (!this.projectHandle) throw new Error("No project open");

    let currentHandle = this.projectHandle;

    // Navigate to target directory if path is not empty/root
    if (path && path !== "." && path !== "/") {
      const parts = path.split("/");
      for (const part of parts) {
        // If any part of the path doesn't exist, we just return empty list or throw?
        // Throwing is better to signal "folder missing" vs "folder empty".
        // But for scanning assets, if assets folder doesn't exist, we probably just want empty list.
        try {
          currentHandle = await currentHandle.getDirectoryHandle(part, {
            create: false,
          });
        } catch (e) {
          console.warn(`Directory not found: ${path}`, e);
          return [];
        }
      }
    }

    const files: string[] = [];
    // Iteration over directory handle

    for await (const [name, handle] of currentHandle.entries()) {
      if (handle.kind === "file") {
        files.push(name);
      }
    }
    return files;
  }
}

export const fileSystemService = new FileSystemService();
