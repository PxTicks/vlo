import {
  getLastProjectSave,
  getProjectSaveRevision,
  subscribeProjectSaved,
} from "../../../core/project/projectLifecycleHooks";
import { registerPreSaveHook } from "../../../core/persistence/preSaveHooks";
import {
  combineRevisionSources,
  createRevisionRelay,
  type RevisionSource,
} from "../../../core/shell/revisionRelay";
import { useProjectStore } from "../../project";
import { extensionProjectStorage } from "../storage/installExtensionProjectStorage";
import { bindOwnerScopedSubscribe } from "../utils/ownerScopedSubscribe";
import type {
  ExtensionApiScope,
  ExtensionProjectApi,
  ExtensionProjectSaveHook,
  ExtensionProjectSnapshot,
} from "../types";

/**
 * How long the host waits for one extension pre-save hook before giving up on
 * it. A save runs on project close, project switch, and every settings change,
 * so a hook that never settles would strand the editor; the budget turns that
 * into a diagnostic and a slightly stale document instead.
 */
export const EXTENSION_PRE_SAVE_HOOK_TIMEOUT_MS = 2000;

/**
 * A project is open only when both the record and its directory handle are
 * present — the store persists the record to localStorage, so after a reload
 * the projects page holds a project with no handle. This matches the
 * `project.open` context key exactly.
 */
function readOpenProject(): ExtensionProjectSnapshot | null {
  const state = useProjectStore.getState();
  if (!state.project || !state.rootHandle) return null;
  const lastSave = getLastProjectSave();
  return Object.freeze({
    id: state.project.id,
    title: state.project.title,
    createdAt: state.project.createdAt,
    lastModified: state.project.lastModified,
    // Scoped to the open project: the save record outlives a close so that a
    // reopened project cannot inherit the previous one's save time.
    lastSavedAt:
      lastSave && lastSave.projectId === state.project.id
        ? lastSave.savedAt
        : null,
  });
}

/** Identity only — render config changes belong to the timeline relay. */
const projectIdentityRelay = createRevisionRelay(useProjectStore, (state) => [
  state.project && state.rootHandle ? state.project.id : null,
  state.project?.title ?? null,
  state.project?.lastModified ?? null,
]);

/**
 * Saves leave no trace in store state, so they signal from the lifecycle
 * module. Combining the two sources keeps the domain on one
 * `subscribe`/`getRevision` pair rather than adding an event channel.
 */
const projectSaveSignal: RevisionSource = Object.freeze({
  subscribe: subscribeProjectSaved,
  getRevision: getProjectSaveRevision,
});

/**
 * Project storage hydrates asynchronously, so `api.storage.project` becomes
 * available *after* the project itself does. Folding availability into this
 * signal is what lets one subscription cover both: a listener that re-reads
 * `storage.project` fires again when the document lands, instead of caching a
 * null it will never be told about.
 */
const projectStorageAvailabilitySignal: RevisionSource = Object.freeze({
  subscribe: (listener: () => void) =>
    extensionProjectStorage.subscribeAvailability(listener),
  getRevision: () => extensionProjectStorage.getDocumentGeneration(),
});

const projectRelay = combineRevisionSources(
  projectIdentityRelay,
  projectSaveSignal,
  projectStorageAvailabilitySignal,
);

/**
 * Runs one extension hook under the host's budget. A rejection or a timeout
 * is advisory: the host reports it and carries on saving, because a save that
 * fails on an extension's behalf loses the user's work, not the extension's.
 */
async function runHookWithBudget(
  scope: ExtensionApiScope,
  hook: ExtensionProjectSaveHook,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(hook),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Pre-save hook exceeded ${EXTENSION_PRE_SAVE_HOOK_TIMEOUT_MS}ms.`,
              ),
            ),
          EXTENSION_PRE_SAVE_HOOK_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    scope.report("warning", "Pre-save hook failed and was skipped.", error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Owner-bound `api.project` (extension-remaining-surfaces plan, Phase H / D3):
 * which project is open, when it was last saved, and a place to flush state
 * before the host writes the document.
 */
export function createExtensionProjectApi(
  scope: ExtensionApiScope,
): ExtensionProjectApi {
  return Object.freeze({
    get: () => readOpenProject(),
    subscribe: bindOwnerScopedSubscribe(scope, projectRelay, "Project"),
    getRevision: () => projectRelay.getRevision(),
    onBeforeSave: (hook: ExtensionProjectSaveHook) => {
      if (typeof hook !== "function") {
        throw new TypeError("Pre-save hook must be a function.");
      }
      if (scope.signal.aborted) return () => undefined;
      const unregister = registerPreSaveHook(() =>
        runHookWithBudget(scope, hook),
      );
      const owned = scope.own({ dispose: () => unregister() });
      return () => {
        void owned.dispose();
      };
    },
  });
}
