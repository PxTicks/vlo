import { applyPatches, produceWithPatches, type Patch } from "../../../lib/immerLite";
import type {
  TimelineClip,
  Transition,
} from "../../../types/TimelineTypes";
import type { TimelineSnapshot } from "../../project/types/ProjectDocument";
import { fileSystemService } from "../../project/services/FileSystemService";
import { projectPersistenceService } from "../../project/services/ProjectPersistenceService";
import { collectMaskBackingAssetIds } from "../model/maskClipModel";
import { pruneInvalidTransitions } from "../model/timelineCommands";
import type { TimelineModelState } from "../model/timelineTrackModel";

const TIMELINE_HISTORY_LIMIT = 100;
const TIMELINE_PERSIST_DEBOUNCE_MS = 250;
const MAX_COALESCED_COMMITS_PER_ENTRY = 256;
type UserAssetsModule = typeof import("../../userAssets");

interface TimelineHistoryEntry {
  label: string;
  forwardPatches: Patch[];
  inversePatches: Patch[];
  trackMaskAssetCleanup: boolean;
  openCoalesceKey: string | null;
  coalescedCommitCount: number;
}

interface TimelineMutationState extends TimelineModelState {
  selectedClipIds: string[];
  selectedTransitionId: string | null;
  copiedClips: TimelineClip[];
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

interface TimelinePostCommitEffects {
  brushMaskClipIdsToDispose?: Iterable<string>;
  maskBackingAssetIdsToDelete?: Iterable<string>;
}

interface TimelineMutationPipelineOptions<State extends TimelineMutationState> {
  get: () => State;
  set: (
    partial:
      | Partial<TimelineMutationState>
      | ((state: State) => Partial<TimelineMutationState>),
  ) => void;
  createDefaultTimelineSnapshot: () => TimelineSnapshot;
  migrateTimelineSnapshot: (snapshot: TimelineSnapshot) => TimelineSnapshot;
}

export interface TimelineMutationCommitOptions {
  label?: string;
  persist?: boolean;
  recordHistory?: boolean;
  trackMaskAssetCleanup?: boolean;
  coalesce?: {
    key: string;
    end: boolean;
  };
}

let didRegisterBeforeUnloadListener = false;
let maskBackingAssetOperationQueue: Promise<void> = Promise.resolve();

function sanitizeSelectedClipIds(
  selectedClipIds: string[],
  clips: TimelineClip[],
): string[] {
  if (selectedClipIds.length === 0) return selectedClipIds;
  const clipIds = new Set(clips.map((clip) => clip.id));
  return selectedClipIds.filter((id) => clipIds.has(id));
}

function getCurrentModelState<State extends TimelineMutationState>(
  state: State,
): TimelineModelState {
  return {
    tracks: state.tracks,
    clips: state.clips,
    transitions: state.transitions,
  };
}

function sanitizeSelectedTransitionId(
  selectedTransitionId: string | null,
  transitions: readonly Transition[],
): string | null {
  if (
    selectedTransitionId &&
    transitions.some((transition) => transition.id === selectedTransitionId)
  ) {
    return selectedTransitionId;
  }
  return null;
}

function queueMaskBackingAssetOperation(
  label: string,
  operation: (assetModule: UserAssetsModule) => Promise<void>,
): void {
  const run = maskBackingAssetOperationQueue
    .catch(() => undefined)
    .then(async () => {
      const assetModule = await import("../../userAssets");
      await operation(assetModule);
    });

  maskBackingAssetOperationQueue = run.catch(() => undefined);

  void run.catch((error) => {
    console.warn(`[TimelineStore] Failed to ${label}`, error);
  });
}

function deleteMaskBackingAssets(assetIds: Iterable<string>): void {
  const uniqueAssetIds = [...new Set([...assetIds].filter(Boolean))];
  if (uniqueAssetIds.length === 0) return;

  queueMaskBackingAssetOperation(
    "delete mask backing assets",
    async ({ deleteAsset }) => {
      for (const assetId of uniqueAssetIds) {
        try {
          await deleteAsset(assetId);
        } catch (error) {
          console.warn(
            `[TimelineStore] Failed to delete mask backing asset '${assetId}'`,
            error,
          );
        }
      }
    },
  );
}

function reconcileDeferredMaskAssetCleanup(
  previousClips: readonly TimelineClip[],
  nextClips: readonly TimelineClip[],
): void {
  const previousAssetIds = collectMaskBackingAssetIds(previousClips);
  const nextAssetIds = collectMaskBackingAssetIds(nextClips);
  const assetIdsToRestore = [...nextAssetIds].filter(
    (assetId) => !previousAssetIds.has(assetId),
  );
  const assetIdsToDelete = [...previousAssetIds].filter(
    (assetId) => !nextAssetIds.has(assetId),
  );

  if (assetIdsToRestore.length === 0 && assetIdsToDelete.length === 0) {
    return;
  }

  queueMaskBackingAssetOperation(
    "reconcile deferred mask cleanup",
    async ({ deleteAsset, restoreDeletedAsset }) => {
      for (const assetId of assetIdsToRestore) {
        try {
          await restoreDeletedAsset(assetId);
        } catch (error) {
          console.warn(
            `[TimelineStore] Failed to restore deferred mask asset '${assetId}'`,
            error,
          );
        }
      }

      for (const assetId of assetIdsToDelete) {
        try {
          await deleteAsset(assetId);
        } catch (error) {
          console.warn(
            `[TimelineStore] Failed to defer mask asset cleanup for '${assetId}'`,
            error,
          );
        }
      }
    },
  );
}

function disposeBrushMaskBuffers(maskClipIds: Iterable<string>): void {
  const uniqueMaskClipIds = [...new Set([...maskClipIds].filter(Boolean))];
  if (uniqueMaskClipIds.length === 0) return;

  void import("../../masks/runtime/brushBufferRegistry")
    .then(({ disposeBrushBuffer }) => {
      uniqueMaskClipIds.forEach((maskClipId) => {
        try {
          disposeBrushBuffer(maskClipId);
        } catch (error) {
          console.warn(
            `[TimelineStore] Failed to dispose brush buffer '${maskClipId}'`,
            error,
          );
        }
      });
    })
    .catch((error) => {
      console.warn(
        "[TimelineStore] Failed to load brush buffer registry for cleanup",
        error,
      );
    });
}

export function createTimelineMutationPipeline<State extends TimelineMutationState>(
  options: TimelineMutationPipelineOptions<State>,
) {
  const {
    get,
    set,
    createDefaultTimelineSnapshot,
    migrateTimelineSnapshot,
  } = options;

  let undoStack: TimelineHistoryEntry[] = [];
  let redoStack: TimelineHistoryEntry[] = [];
  let pendingDocumentPatches: Patch[] = [];
  let pendingPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let flushInFlight: Promise<void> | null = null;
  let persistenceSuspended = false;

  const applyHistoryFlags = () => ({
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: undoStack.at(-1)?.label ?? null,
    redoLabel: redoStack.at(-1)?.label ?? null,
  });

  const queueTimelinePatchesForPersistence = (timelinePatches: Patch[]): void => {
    if (timelinePatches.length === 0) return;
    if (persistenceSuspended) return;
    if (!fileSystemService.getHandle()) return;

    pendingDocumentPatches.push(...timelinePatches);

    if (pendingPersistTimer !== null) return;

    pendingPersistTimer = setTimeout(() => {
      pendingPersistTimer = null;
      void flushPendingPersistence();
    }, TIMELINE_PERSIST_DEBOUNCE_MS);
  };

  const flushPendingPersistence = async (): Promise<void> => {
    if (persistenceSuspended) {
      if (pendingPersistTimer !== null) {
        clearTimeout(pendingPersistTimer);
        pendingPersistTimer = null;
      }
      pendingDocumentPatches = [];
      return;
    }

    if (pendingPersistTimer !== null) {
      clearTimeout(pendingPersistTimer);
      pendingPersistTimer = null;
    }

    if (flushInFlight) {
      await flushInFlight;
    }

    if (pendingDocumentPatches.length === 0) return;
    if (!fileSystemService.getHandle()) {
      pendingDocumentPatches = [];
      return;
    }

    const patchesToApply = pendingDocumentPatches;
    pendingDocumentPatches = [];

    const fallbackSnapshot: TimelineSnapshot = {
      tracks: structuredClone(get().tracks),
      clips: structuredClone(get().clips),
      transitions: structuredClone(get().transitions),
    };

    flushInFlight = projectPersistenceService
      .applyTimelinePatches(patchesToApply, fallbackSnapshot)
      .then(() => undefined)
      .catch(async (error) => {
        console.error(
          "[TimelineStore] Failed to apply timeline patches; writing snapshot fallback.",
          error,
        );

        await projectPersistenceService.updateTimeline((draft) => {
          draft.tracks = structuredClone(fallbackSnapshot.tracks);
          draft.clips = structuredClone(fallbackSnapshot.clips);
          draft.transitions = structuredClone(
            fallbackSnapshot.transitions ?? [],
          );
        });
      })
      .finally(() => {
        flushInFlight = null;
      });

    await flushInFlight;

    if (pendingDocumentPatches.length > 0) {
      await flushPendingPersistence();
    }
  };

  const commitModelMutation = (
    recipe: (draft: TimelineModelState) => void,
    commitOptions?: TimelineMutationCommitOptions,
  ): boolean => {
    const {
      label = "Timeline change",
      persist = true,
      recordHistory = true,
      trackMaskAssetCleanup = true,
      coalesce,
    } = commitOptions ?? {};

    const currentModel = getCurrentModelState(get());
    const [nextModel, forwardPatches, inversePatches] = produceWithPatches(
      currentModel,
      (draft) => {
        recipe(draft);
        pruneInvalidTransitions(draft);
      },
    );

    if (forwardPatches.length === 0) {
      if (recordHistory && coalesce?.end) {
        const previous = undoStack.at(-1);
        if (previous?.openCoalesceKey === coalesce.key) {
          previous.openCoalesceKey = null;
        }
      }
      return false;
    }

    if (recordHistory) {
      const previous = undoStack.at(-1);
      if (
        coalesce &&
        previous?.openCoalesceKey === coalesce.key &&
        previous.coalescedCommitCount < MAX_COALESCED_COMMITS_PER_ENTRY
      ) {
        previous.label = label;
        previous.forwardPatches.push(...forwardPatches);
        previous.inversePatches.unshift(...inversePatches);
        previous.trackMaskAssetCleanup ||= trackMaskAssetCleanup;
        previous.coalescedCommitCount += 1;
        if (coalesce.end) previous.openCoalesceKey = null;
      } else {
        if (previous) previous.openCoalesceKey = null;
        undoStack.push({
          label,
          forwardPatches,
          inversePatches,
          trackMaskAssetCleanup,
          openCoalesceKey: coalesce && !coalesce.end ? coalesce.key : null,
          coalescedCommitCount: 1,
        });
      }
      if (undoStack.length > TIMELINE_HISTORY_LIMIT) {
        undoStack.shift();
      }
      redoStack = [];
    } else {
      const previous = undoStack.at(-1);
      if (previous) previous.openCoalesceKey = null;
    }

    set((state) => ({
      tracks: nextModel.tracks,
      clips: nextModel.clips,
      transitions: nextModel.transitions,
      selectedClipIds: sanitizeSelectedClipIds(
        state.selectedClipIds,
        nextModel.clips,
      ),
      selectedTransitionId: sanitizeSelectedTransitionId(
        state.selectedTransitionId,
        nextModel.transitions,
      ),
      ...applyHistoryFlags(),
    }));

    if (persist) {
      queueTimelinePatchesForPersistence(forwardPatches);
    }

    return true;
  };

  const undo = (): boolean => {
    const entry = undoStack.pop();
    if (!entry) return false;
    entry.openCoalesceKey = null;

    const currentModel = getCurrentModelState(get());
    const nextModel = applyPatches(
      currentModel,
      entry.inversePatches,
    ) as TimelineModelState;

    redoStack.push(entry);

    set((state) => ({
      tracks: nextModel.tracks,
      clips: nextModel.clips,
      transitions: nextModel.transitions,
      selectedClipIds: sanitizeSelectedClipIds(
        state.selectedClipIds,
        nextModel.clips,
      ),
      selectedTransitionId: sanitizeSelectedTransitionId(
        state.selectedTransitionId,
        nextModel.transitions,
      ),
      ...applyHistoryFlags(),
    }));

    if (entry.trackMaskAssetCleanup) {
      reconcileDeferredMaskAssetCleanup(currentModel.clips, nextModel.clips);
    }

    queueTimelinePatchesForPersistence(entry.inversePatches);
    return true;
  };

  const redo = (): boolean => {
    const entry = redoStack.pop();
    if (!entry) return false;
    entry.openCoalesceKey = null;

    const currentModel = getCurrentModelState(get());
    const nextModel = applyPatches(
      currentModel,
      entry.forwardPatches,
    ) as TimelineModelState;

    undoStack.push(entry);
    if (undoStack.length > TIMELINE_HISTORY_LIMIT) {
      undoStack.shift();
    }

    set((state) => ({
      tracks: nextModel.tracks,
      clips: nextModel.clips,
      transitions: nextModel.transitions,
      selectedClipIds: sanitizeSelectedClipIds(
        state.selectedClipIds,
        nextModel.clips,
      ),
      selectedTransitionId: sanitizeSelectedTransitionId(
        state.selectedTransitionId,
        nextModel.transitions,
      ),
      ...applyHistoryFlags(),
    }));

    if (entry.trackMaskAssetCleanup) {
      reconcileDeferredMaskAssetCleanup(currentModel.clips, nextModel.clips);
    }

    queueTimelinePatchesForPersistence(entry.forwardPatches);
    return true;
  };

  const replaceTimelineSnapshot = (snapshot: TimelineSnapshot | null): void => {
    if (pendingPersistTimer !== null) {
      clearTimeout(pendingPersistTimer);
      pendingPersistTimer = null;
    }
    pendingDocumentPatches = [];
    undoStack = [];
    redoStack = [];

    const migrated = snapshot
      ? migrateTimelineSnapshot(snapshot)
      : createDefaultTimelineSnapshot();
    const next: TimelineModelState = {
      tracks: migrated.tracks,
      clips: migrated.clips,
      transitions: migrated.transitions ?? [],
    };
    pruneInvalidTransitions(next);

    set({
      tracks: next.tracks,
      clips: next.clips,
      transitions: next.transitions,
      selectedClipIds: [],
      selectedTransitionId: null,
      copiedClips: [],
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
    });
  };

  const setPersistenceSuspended = (suspended: boolean): void => {
    persistenceSuspended = suspended;
    if (!suspended) return;

    if (pendingPersistTimer !== null) {
      clearTimeout(pendingPersistTimer);
      pendingPersistTimer = null;
    }
    pendingDocumentPatches = [];
  };

  const registerBeforeUnloadPersistence = (): void => {
    if (typeof window === "undefined" || didRegisterBeforeUnloadListener) {
      return;
    }

    window.addEventListener("beforeunload", () => {
      void flushPendingPersistence();
    });
    didRegisterBeforeUnloadListener = true;
  };

  const runPostCommitEffects = (effects: TimelinePostCommitEffects): void => {
    if (effects.brushMaskClipIdsToDispose) {
      disposeBrushMaskBuffers(effects.brushMaskClipIdsToDispose);
    }

    if (effects.maskBackingAssetIdsToDelete) {
      deleteMaskBackingAssets(effects.maskBackingAssetIdsToDelete);
    }
  };

  return {
    commitModelMutation,
    flushPendingPersistence,
    redo,
    registerBeforeUnloadPersistence,
    replaceTimelineSnapshot,
    runPostCommitEffects,
    setPersistenceSuspended,
    undo,
  };
}
