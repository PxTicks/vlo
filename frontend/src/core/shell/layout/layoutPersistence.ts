/**
 * Storage seam for the shell layout (plan §4.3). The kernel only ever sees this
 * interface, so account synchronization can replace the local implementation
 * later without touching the resolver, the store, or any component.
 */
import {
  LEGACY_VIEW_LAYOUT_STORAGE_KEY,
  SHELL_LAYOUT_STORAGE_KEY,
  selectShellLayoutDocument,
} from "./layoutMigrations";
import {
  EMPTY_SHELL_LAYOUT_DOCUMENT,
  type ShellLayoutDocumentV2,
} from "./layoutTypes";

export interface ShellLayoutPersistence {
  /** Always returns a usable document; unreadable storage means "no preference". */
  read(): ShellLayoutDocumentV2;
  write(document: ShellLayoutDocumentV2): void;
}

export interface ShellLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getDefaultStorage(): ShellLayoutStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage access throws outright under some privacy settings.
    return null;
  }
}

function readJson(storage: ShellLayoutStorage, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    if (raw === null || raw === "") return undefined;
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Reads the version 2 document, falling back to migrating the version 1
 * HostViewRegistry preferences. The legacy key is never written or removed:
 * until every reader has moved to the kernel, both must keep working.
 */
export function createLocalShellLayoutPersistence(
  storage: ShellLayoutStorage | null = getDefaultStorage(),
): ShellLayoutPersistence {
  return Object.freeze({
    read: (): ShellLayoutDocumentV2 => {
      if (!storage) return EMPTY_SHELL_LAYOUT_DOCUMENT;
      return selectShellLayoutDocument({
        current: readJson(storage, SHELL_LAYOUT_STORAGE_KEY),
        legacy: readJson(storage, LEGACY_VIEW_LAYOUT_STORAGE_KEY),
      });
    },
    write: (document: ShellLayoutDocumentV2): void => {
      if (!storage) return;
      try {
        storage.setItem(SHELL_LAYOUT_STORAGE_KEY, JSON.stringify(document));
      } catch {
        // The in-memory layout still works when storage is full or blocked.
      }
    },
  });
}

export interface MemoryShellLayoutPersistence extends ShellLayoutPersistence {
  /** The most recently written document, for assertions and fixtures. */
  readonly current: ShellLayoutDocumentV2;
  readonly writeCount: number;
}

/** Non-persistent implementation for tests and ephemeral hosts. */
export function createMemoryShellLayoutPersistence(
  initial: ShellLayoutDocumentV2 = EMPTY_SHELL_LAYOUT_DOCUMENT,
): MemoryShellLayoutPersistence {
  let document = initial;
  let writeCount = 0;
  return {
    get current() {
      return document;
    },
    get writeCount() {
      return writeCount;
    },
    read: () => document,
    write: (next) => {
      document = next;
      writeCount += 1;
    },
  };
}
