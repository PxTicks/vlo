import { fileSystemService } from "./FileSystemService";

const PROJECT_TEMPORARY_DIR = ".vloproject/temporary";
const IFRAME_SELECTION_DIR = `${PROJECT_TEMPORARY_DIR}/iframe-selections`;

type ClearListener = () => void;

function fileExtension(filename: string): string {
  const match = filename.match(/(\.[a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() ?? ".bin";
}

class ProjectTemporaryFileService {
  private readonly clearListeners = new Set<ClearListener>();

  onClear(listener: ClearListener): () => void {
    this.clearListeners.add(listener);
    return () => this.clearListeners.delete(listener);
  }

  async writeIframeSelectionFile(
    id: string,
    role: "video" | "mask" | "thumbnail",
    file: File,
  ): Promise<string> {
    const path = `${IFRAME_SELECTION_DIR}/${id}-${role}${fileExtension(file.name)}`;
    await fileSystemService.writeFile(path, file);
    return path;
  }

  async clearTemporaryFiles(): Promise<void> {
    for (const listener of this.clearListeners) {
      listener();
    }

    if (!fileSystemService.getHandle()) {
      return;
    }

    await fileSystemService.removeEntry(PROJECT_TEMPORARY_DIR, {
      recursive: true,
    });
  }
}

export const projectTemporaryFileService = new ProjectTemporaryFileService();
