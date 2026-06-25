import { openDB, type DBSchema, type IDBPDatabase } from "idb";

interface NewProjectDirectoryPreference {
  id: string;
  handle: FileSystemDirectoryHandle;
}

interface NewProjectDirectoryDB extends DBSchema {
  preferences: {
    key: string;
    value: NewProjectDirectoryPreference;
  };
}

const DB_NAME = "vlo-project-preferences";
const STORE_NAME = "preferences";
const PROJECT_DIRECTORY_KEY = "new-project-directory";

export class NewProjectDirectoryService {
  private dbPromise: Promise<IDBPDatabase<NewProjectDirectoryDB>>;

  constructor() {
    this.dbPromise = openDB<NewProjectDirectoryDB>(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      },
    });
  }

  async getDirectory(): Promise<FileSystemDirectoryHandle | null> {
    const db = await this.dbPromise;
    const preference = await db.get(STORE_NAME, PROJECT_DIRECTORY_KEY);
    return preference?.handle ?? null;
  }

  async setDirectory(handle: FileSystemDirectoryHandle): Promise<void> {
    const db = await this.dbPromise;
    await db.put(STORE_NAME, {
      id: PROJECT_DIRECTORY_KEY,
      handle,
    });
  }
}

export const newProjectDirectoryService = new NewProjectDirectoryService();
