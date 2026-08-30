import { registerPreSaveHook } from "../../../core/persistence/preSaveHooks";
import { registerProjectClosingHook } from "../../../core/project/projectLifecycleHooks";
import { useProjectStore } from "../../project";
import { projectPersistenceService } from "../../project/services/ProjectPersistenceService";
import { useGenerationStore } from "../useGenerationStore";
import {
  buildGenerationPanelSnapshot,
  parseGenerationPanelSnapshot,
  toPersistedGenerationPanel,
  type GenerationPanelSnapshot,
} from "./generationPanelSnapshot";

/**
 * How long panel edits settle before they are written. Typing in a prompt is
 * the common case, so the delay is what keeps a keystroke from becoming a
 * file write; a project save flushes ahead of it either way.
 */
const WRITE_DEBOUNCE_MS = 1_500;

function readCurrentSnapshot(): GenerationPanelSnapshot | null {
  const state = useGenerationStore.getState();
  return buildGenerationPanelSnapshot({
    workflowId: state.selectedWorkflowId,
    workflowRules: state.activeWorkflowRules,
    workflowInputs: state.workflowInputs,
    mediaInputs: state.mediaInputs,
    targetResolution: state.targetResolution,
    targetResolutionIsCustom: state.targetResolutionIsCustom,
    exactAspectRatio: state.exactAspectRatio,
    aspectRatioSelection: state.aspectRatioSelection,
    maskCropMode: state.maskCropMode,
    maskCropDilation: state.maskCropDilation,
    values: state.panelValues,
  });
}

function readProjectId(): string | null {
  const state = useProjectStore.getState();
  return state.project && state.rootHandle ? state.project.id : null;
}

/**
 * Keeps the generation panel's state with the project: saved as it changes,
 * and handed back when the project is reopened.
 *
 * Restoration is deliberately two-staged. Opening a project only loads the
 * saved snapshot into the store; the panel performs it on mount, because
 * putting media slots back renders timeline selections and so needs the
 * timeline the project is still loading.
 */
export function installGenerationPanelPersistence(): () => void {
  let currentProjectId = readProjectId();
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingWrite: Promise<void> = Promise.resolve();
  let lastWritten: string | null = null;

  const cancelScheduledWrite = () => {
    if (writeTimer !== null) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
  };

  const writeNow = (): Promise<void> => {
    cancelScheduledWrite();
    if (currentProjectId === null) return pendingWrite;

    const state = useGenerationStore.getState();
    // The project's saved state is still waiting to be restored, or is being
    // restored right now. Either way what the panel holds is not this
    // project's state, and a restore that fails or is interrupted must leave
    // the copy on disk intact rather than record a partial one over it.
    if (state.pendingPanelSnapshot !== null) return pendingWrite;
    if (state.isRestoringPanelSnapshot) return pendingWrite;

    const snapshot = readCurrentSnapshot();
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastWritten) return pendingWrite;
    lastWritten = serialized;

    pendingWrite = pendingWrite
      .catch(() => undefined)
      .then(async () => {
        await projectPersistenceService.writeGenerationPanel(
          toPersistedGenerationPanel(snapshot),
        );
      })
      .catch((error: unknown) => {
        console.warn("[Generation] Failed to save panel state", error);
        // Let the next change try again rather than trusting the cache.
        lastWritten = null;
      });

    return pendingWrite;
  };

  const scheduleWrite = () => {
    if (currentProjectId === null) return;
    cancelScheduledWrite();
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void writeNow();
    }, WRITE_DEBOUNCE_MS);
  };

  const openProject = (projectId: string | null) => {
    cancelScheduledWrite();
    currentProjectId = projectId;
    lastWritten = null;
    useGenerationStore.getState().clearPanelForProjectChange();
    if (projectId === null) return;

    void loadSavedSnapshot(projectId);
  };

  const loadSavedSnapshot = (projectId: string) => {

    return (async () => {
      try {
        const document = await projectPersistenceService.readGenerationPanel();
        if (currentProjectId !== projectId) return;
        const snapshot = parseGenerationPanelSnapshot(document.panel);
        if (!snapshot) {
          // Nothing to restore: record what the file already says so opening
          // a project does not rewrite it with the same emptiness.
          lastWritten = JSON.stringify(null);
          return;
        }
        lastWritten = JSON.stringify(snapshot);
        useGenerationStore.getState().setPendingPanelSnapshot(snapshot);
      } catch (error) {
        console.warn("[Generation] Failed to read saved panel state", error);
      }
    })();
  };

  const unsubscribeProject = useProjectStore.subscribe(() => {
    const nextProjectId = readProjectId();
    if (nextProjectId === currentProjectId) return;
    openProject(nextProjectId);
  });

  let previousSignature = readStoreSignature();
  const unsubscribeGeneration = useGenerationStore.subscribe(() => {
    const signature = readStoreSignature();
    if (signaturesMatch(signature, previousSignature)) return;
    previousSignature = signature;
    scheduleWrite();
  });

  const unregisterPreSave = registerPreSaveHook(() => writeNow());
  const unregisterClosing = registerProjectClosingHook(() => {
    cancelScheduledWrite();
    return pendingWrite.catch(() => undefined);
  });

  if (currentProjectId !== null) {
    // Installing is not a project change: the editor can remount inside one
    // project, and whatever the panel already holds is that project's live
    // state. Only an untouched panel takes the saved state from disk.
    if (useGenerationStore.getState().selectedWorkflowId === null) {
      void loadSavedSnapshot(currentProjectId);
    }
  }

  return () => {
    cancelScheduledWrite();
    unregisterClosing();
    unregisterPreSave();
    unsubscribeGeneration();
    unsubscribeProject();
  };
}

/**
 * The parts of the store a snapshot is built from. The store also carries
 * jobs, previews and socket status, which change constantly during a
 * generation and mean nothing to saved panel state — so changes are detected
 * by identity over these fields only, never by walking the whole store.
 */
function readStoreSignature(): readonly unknown[] {
  const state = useGenerationStore.getState();
  return [
    state.selectedWorkflowId,
    state.targetResolution,
    state.targetResolutionIsCustom,
    state.exactAspectRatio,
    state.aspectRatioSelection,
    state.maskCropMode,
    state.maskCropDilation,
    state.panelValues,
    state.mediaInputs,
    state.workflowInputs,
  ];
}

function signaturesMatch(
  a: readonly unknown[],
  b: readonly unknown[],
): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
