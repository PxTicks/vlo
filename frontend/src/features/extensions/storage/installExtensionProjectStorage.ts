import { useProjectStore } from "../../project";
import { projectPersistenceService } from "../../project/services/ProjectPersistenceService";
import {
  registerProjectClosingHook,
  type ProjectClosingHook,
} from "../../../core/project/projectLifecycleHooks";
import type { ExtensionDisposable } from "../types";
import { ExtensionProjectStorage } from "./ExtensionProjectStorage";

/** Singleton backed by the project persistence document. */
export const extensionProjectStorage = new ExtensionProjectStorage({
  readNamespaces: async () =>
    (await projectPersistenceService.readExtensionStorage()).storage,
  writeNamespace: (extensionId, record) =>
    projectPersistenceService.updateExtensionStorageNamespace(
      extensionId,
      record,
    ),
});

/**
 * Hydrates/clears the project storage projection as projects open and close.
 * A project-ID change without an intermediate close (open-over-open) cycles
 * the store so namespaces never leak across projects.
 */
export function installExtensionProjectStorage(
  storage: ExtensionProjectStorage = extensionProjectStorage,
  registerClosingHook: (
    hook: ProjectClosingHook,
  ) => () => void = registerProjectClosingHook,
): ExtensionDisposable {
  const readSignature = () => {
    const state = useProjectStore.getState();
    return state.project && state.rootHandle ? state.project.id : null;
  };

  let currentProjectId = readSignature();
  let generation = 0;
  let transitionQueue = Promise.resolve();

  const transition = (nextProjectId: string | null) => {
    generation += 1;
    const thisGeneration = generation;
    transitionQueue = transitionQueue
      .catch(() => undefined)
      .then(async () => {
        if (thisGeneration !== generation) return;
        if (storage.isOpen()) await storage.closeProject();
        if (thisGeneration !== generation || nextProjectId === null) return;
        await storage.openForProject();
        // A close or newer project may have superseded hydration while its
        // File System Access read was in flight. Do not expose stale data.
        if (thisGeneration !== generation && storage.isOpen()) {
          await storage.closeProject();
        }
    });
    void transitionQueue.catch((error: unknown) => {
      console.error(
        "[ExtensionStorage] Project storage transition failed.",
        error,
      );
    });
  };

  const unregisterClosingHook = registerClosingHook(async () => {
    // Project lifecycle hooks run before FileSystemService changes handles.
    // Invalidate pending hydration, wait for it, and flush against the old
    // handle so an open-over-open transition cannot cross project data.
    generation += 1;
    await transitionQueue.catch(() => undefined);
    if (storage.isOpen()) await storage.closeProject();
  });

  if (currentProjectId !== null) transition(currentProjectId);
  const unsubscribe = useProjectStore.subscribe(() => {
    const nextProjectId = readSignature();
    if (nextProjectId === currentProjectId) return;
    currentProjectId = nextProjectId;
    transition(nextProjectId);
  });

  let disposed = false;
  return Object.freeze({
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      unregisterClosingHook();
      generation += 1;
      await transitionQueue.catch(() => undefined);
      if (storage.isOpen()) await storage.closeProject();
    },
  });
}
