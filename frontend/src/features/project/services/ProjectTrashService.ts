import { fileSystemService } from "./FileSystemService";

const PROJECT_TRASH_DIR = ".vloproject/trash";

export const PROJECT_TRASH_LIMIT_BYTES = 300 * 1024 * 1024;

export interface ProjectTrashFile {
  originalPath: string;
  trashPath: string;
  sizeBytes: number;
}

export interface ProjectTrashItem {
  id: string;
  createdAt: number;
  sizeBytes: number;
  files: ProjectTrashFile[];
}

function isNotFoundError(error: unknown): boolean {
  return (
    (error as DOMException | undefined)?.name === "NotFoundError" ||
    (error instanceof Error && /not found|missing/i.test(error.message))
  );
}

export function isLocalProjectPath(path: string | undefined): path is string {
  return Boolean(
    path &&
      !path.startsWith("http://") &&
      !path.startsWith("https://") &&
      !path.startsWith("blob:"),
  );
}

function createTrashItemId(): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    Math.random().toString(36).slice(2);
  return `${Date.now()}_${random}`;
}

function trashFilePath(trashItemId: string, originalPath: string): string {
  return `${PROJECT_TRASH_DIR}/${trashItemId}/files/${encodeURIComponent(
    originalPath,
  )}`;
}

export class ProjectTrashService {
  async clearTrash(): Promise<void> {
    if (!fileSystemService.getHandle()) {
      return;
    }

    try {
      await fileSystemService.removeEntry(PROJECT_TRASH_DIR, {
        recursive: true,
      });
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  async moveFilesToTrash(paths: Iterable<string>): Promise<ProjectTrashItem> {
    const id = createTrashItemId();
    const createdAt = Date.now();
    const files: ProjectTrashFile[] = [];
    const uniquePaths = [...new Set([...paths].filter(isLocalProjectPath))];

    for (const originalPath of uniquePaths) {
      try {
        const file = await fileSystemService.readFile(originalPath);
        const trashPath = trashFilePath(id, originalPath);
        await fileSystemService.writeFile(trashPath, file);
        await fileSystemService.deleteFile(originalPath);
        files.push({
          originalPath,
          trashPath,
          sizeBytes: file.size,
        });
      } catch (error) {
        if (!isNotFoundError(error)) {
          console.warn(
            `[ProjectTrashService] Failed to move '${originalPath}' to trash.`,
            error,
          );
        }
      }
    }

    const sizeBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
    if (files.length === 0) {
      await this.deleteTrashItem({
        id,
        createdAt,
        sizeBytes,
        files,
      });
    }

    return {
      id,
      createdAt,
      sizeBytes,
      files,
    };
  }

  async restoreTrashItem(item: ProjectTrashItem): Promise<void> {
    for (const file of item.files) {
      try {
        const trashedFile = await fileSystemService.readFile(file.trashPath);
        await fileSystemService.writeFile(file.originalPath, trashedFile);
      } catch (error) {
        if (!isNotFoundError(error)) {
          console.warn(
            `[ProjectTrashService] Failed to restore '${file.originalPath}' from trash.`,
            error,
          );
        }
      }
    }

    await this.deleteTrashItem(item);
  }

  async deleteTrashItem(item: ProjectTrashItem): Promise<void> {
    if (!fileSystemService.getHandle()) {
      return;
    }

    try {
      await fileSystemService.removeEntry(`${PROJECT_TRASH_DIR}/${item.id}`, {
        recursive: true,
      });
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }
}

export const projectTrashService = new ProjectTrashService();
