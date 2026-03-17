
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface RecentProject {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  lastOpened: number;
}

interface RecentProjectsDB extends DBSchema {
  recentProjects: {
    key: string;
    value: RecentProject;
    indexes: { "by-date": number };
  };
}

const DB_NAME = "vlo-recent-projects";
const STORE_NAME = "recentProjects";

export class RecentProjectsService {
  private dbPromise: Promise<IDBPDatabase<RecentProjectsDB>>;

  constructor() {
    this.dbPromise = openDB<RecentProjectsDB>(DB_NAME, 1, {
      upgrade(db) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("by-date", "lastOpened");
      },
    });
  }

  async addRecent(
    id: string,
    name: string,
    handle: FileSystemDirectoryHandle
  ): Promise<void> {
    const db = await this.dbPromise;
    
    // 1. Get all current recents to check for duplicates
    // We need to do this because different handles can point to the same directory
    // and we want to remove "stale" entries for this same directory.
    const all = await db.getAll(STORE_NAME);
    
    for (const recent of all) {
      if (recent.id === id) continue; // Will be overwritten anyway
      
      try {
        // isSameEntry is the only way to check if two handles point to the same folder
        const isSame = await handle.isSameEntry(recent.handle);
        if (isSame) {
             // Found a duplicate (different ID, same folder). Remove it.
             await db.delete(STORE_NAME, recent.id);
        }
      } catch (e) {
         // Handle check might fail if permission lost or handle invalid, ignore
         console.warn("Failed to check handle equality during deduplication", e);
      }
    }

    await db.put(STORE_NAME, {
      id,
      name,
      handle,
      lastOpened: Date.now(),
    });
  }

  async getRecents(): Promise<RecentProject[]> {
    const db = await this.dbPromise;
    // Get all and sort locally or use cursor. For small lists, getting all is fine.
    const all = await db.getAll(STORE_NAME);
    return all.sort((a, b) => b.lastOpened - a.lastOpened);
  }

  async removeRecent(id: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete(STORE_NAME, id);
  }
}

export const recentProjectsService = new RecentProjectsService();
