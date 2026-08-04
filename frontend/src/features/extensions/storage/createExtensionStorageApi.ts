import type {
  ExtensionApiScope,
  ExtensionKeyValueStore,
  ExtensionStorageApi,
  JsonValue,
} from "../types";
import {
  assertStorageKey,
  cloneStorageValue,
} from "./ExtensionProjectStorage";
import { extensionProjectStorage } from "./installExtensionProjectStorage";
import {
  deleteLocalStorageValue,
  getLocalStorageValue,
  listLocalStorageKeys,
  setLocalStorageValue,
} from "./localStorageClient";

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

function wrapListener(
  scope: ExtensionApiScope,
  label: string,
  listener: () => void,
): () => void {
  if (typeof listener !== "function") {
    throw new TypeError(`${label} subscriber must be a function.`);
  }
  return () => {
    try {
      listener();
    } catch (error) {
      scope.report("error", `${label} subscriber failed.`, error);
    }
  };
}

function createLocalStore(scope: ExtensionApiScope): ExtensionKeyValueStore {
  const extensionId = scope.extension.id;
  const listeners = new Set<() => void>();
  let revision = 0;
  const notify = () => {
    revision += 1;
    for (const listener of [...listeners]) listener();
  };
  return Object.freeze({
    get: async (key: string) => {
      assertStorageKey(key);
      abortIfNeeded(scope.signal);
      return getLocalStorageValue(extensionId, key);
    },
    set: async (key: string, value: JsonValue) => {
      assertStorageKey(key);
      const cloned = cloneStorageValue(value);
      abortIfNeeded(scope.signal);
      await setLocalStorageValue(extensionId, key, cloned);
      notify();
    },
    delete: async (key: string) => {
      assertStorageKey(key);
      abortIfNeeded(scope.signal);
      await deleteLocalStorageValue(extensionId, key);
      notify();
    },
    keys: async () => {
      abortIfNeeded(scope.signal);
      return listLocalStorageKeys(extensionId);
    },
    subscribe: (listener: () => void) => {
      const wrapped = wrapListener(scope, "Local storage", listener);
      if (scope.signal.aborted) return () => undefined;
      listeners.add(wrapped);
      const owned = scope.own({
        dispose: () => {
          listeners.delete(wrapped);
        },
      });
      return () => {
        void owned.dispose();
      };
    },
    getRevision: () => revision,
  });
}

function createProjectStore(scope: ExtensionApiScope): ExtensionKeyValueStore {
  const extensionId = scope.extension.id;
  return Object.freeze({
    get: async (key: string) => extensionProjectStorage.get(extensionId, key),
    set: async (key: string, value: JsonValue) => {
      extensionProjectStorage.set(extensionId, key, value);
    },
    delete: async (key: string) => {
      extensionProjectStorage.delete(extensionId, key);
    },
    keys: async () => extensionProjectStorage.keys(extensionId),
    subscribe: (listener: () => void) => {
      const wrapped = wrapListener(scope, "Project storage", listener);
      if (scope.signal.aborted) return () => undefined;
      const unsubscribe = extensionProjectStorage.subscribe(
        extensionId,
        wrapped,
      );
      const owned = scope.own({ dispose: () => unsubscribe() });
      return () => {
        void owned.dispose();
      };
    },
    getRevision: () => extensionProjectStorage.getRevision(extensionId),
  });
}

/**
 * Owner-bound `api.storage` (extension-shell-surfaces plan §4). `local` is
 * backend-owned and survives project switches; `project` reflects the open
 * project's storage document and is null while no project is open. Neither
 * scope is undoable — timeline-coupled state belongs in payloads.
 */
export function createExtensionStorageApi(
  scope: ExtensionApiScope,
): ExtensionStorageApi {
  const local = createLocalStore(scope);
  const project = createProjectStore(scope);
  return Object.freeze({
    local,
    get project(): ExtensionKeyValueStore | null {
      return extensionProjectStorage.isOpen() ? project : null;
    },
  });
}
