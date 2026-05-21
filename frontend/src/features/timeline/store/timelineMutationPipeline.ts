import { applyPatches, produceWithPatches, type Patch } from "../../../lib/immerLite";
import type { TimelineClip } from "../../../types/TimelineTypes";
import type { TimelineSnapshot } from "../../project/types/ProjectDocument";
import { fileSystemService } from "../../project/services/FileSystemService";
import { projectPersistenceService } from "../../project/services/ProjectPersistenceService";
import type { TimelineModelState } from "../model/timelineTrackModel";

const TIMELINE_HISTORY_LIMIT = 100;
const TIMELINE_PERSIST_DEBOUNCE_MS = 250;

interface TimelineHistoryEntry {
  forwardPatches: Patch[];
  inversePatches: Patch[];
}

interface TimelineMutationState extends TimelineModelState {
  selectedClipIds: string[];
  copiedClips: TimelineClip[];
  canUndo: boolean;
  canRedo: boolean;
}

interface TimelinePostCommitEffects {
  brushMaskClipIdsToDispose?: Iterable<string>;
  compositeProxyAssetIdsToDelete?: Iterable<string>;
  sam2MaskAssetIdsToDelete?: Iterable<string>;
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
  persist?: boolean;
  recordHistory?: boolean;
}

let didRegisterBeforeUnloadListener = false;

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
  };
}

function deleteSam2MaskAssets(assetIds: Iterable<string>): void {
  const uniqueAssetIds = [...new Set([...assetIds].filter(Boolean))];
  if (uniqueAssetIds.length === 0) return;

  void import("../../userAssets")
    .then(async ({ deleteAsset }) => {
      for (const assetId of uniqueAssetIds) {
        try {
          await deleteAsset(assetId);
        } catch (error) {
          console.warn(
            `[TimelineStore] Failed to delete SAM2 mask asset '${assetId}'`,
            error,
          );
        }
      }
    })
    .catch((error) => {
      console.warn(
        "[TimelineStore] Failed to load asset store for SAM2 mask cleanup",
        error,
      );
    });
}

function deleteCompositeProxyAssets(assetIds: Iterable<string>): void {
  const uniqueAssetIds = [...new Set([...assetIds].filter(Boolean))];
  if (uniqueAssetIds.length === 0) return;

  void import("../../userAssets")
    .then(async ({ deleteAsset }) => {
      for (const assetId of uniqueAssetIds) {
        try {
          await deleteAsset(assetId);
        } catch (error) {
          console.warn(
            `[TimelineStore] Failed to delete composite proxy asset '${assetId}'`,
            error,
          );
        }
      }
    })
    .catch((error) => {
      console.warn(
        "[TimelineStore] Failed to load asset store for composite proxy cleanup",
        error,
      );
    });
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

  const applyHistoryFlags = () => ({
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  });

  const queueTimelinePatchesForPersistence = (timelinePatches: Patch[]): void => {
    if (timelinePatches.length === 0) return;
    if (!fileSystemService.getHandle()) return;

    pendingDocumentPatches.push(...timelinePatches);

    if (pendingPersistTimer !== null) return;

    pendingPersistTimer = setTimeout(() => {
      pendingPersistTimer = null;
      void flushPendingPersistence();
    }, TIMELINE_PERSIST_DEBOUNCE_MS);
  };

  const flushPendingPersistence = async (): Promise<void> => {
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
    const { persist = true, recordHistory = true } = commitOptions ?? {};

    const currentModel = getCurrentModelState(get());
    const [nextModel, forwardPatches, inversePatches] = produceWithPatches(
      currentModel,
      recipe,
    );

    if (forwardPatches.length === 0) return false;

    if (recordHistory) {
      undoStack.push({ forwardPatches, inversePatches });
      if (undoStack.length > TIMELINE_HISTORY_LIMIT) {
        undoStack.shift();
      }
      redoStack = [];
    }

    set((state) => ({
      tracks: nextModel.tracks,
      clips: nextModel.clips,
      selectedClipIds: sanitizeSelectedClipIds(
        state.selectedClipIds,
        nextModel.clips,
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

    const currentModel = getCurrentModelState(get());
    const nextModel = applyPatches(
      currentModel,
      entry.inversePatches,
    ) as TimelineModelState;

    redoStack.push(entry);

    set((state) => ({
      tracks: nextModel.tracks,
      clips: nextModel.clips,
      selectedClipIds: sanitizeSelectedClipIds(
        state.selectedClipIds,
        nextModel.clips,
      ),
      ...applyHistoryFlags(),
    }));

    queueTimelinePatchesForPersistence(entry.inversePatches);
    return true;
  };

  const redo = (): boolean => {
    const entry = redoStack.pop();
    if (!entry) return false;

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
      selectedClipIds: sanitizeSelectedClipIds(
        state.selectedClipIds,
        nextModel.clips,
      ),
      ...applyHistoryFlags(),
    }));

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

    const next = snapshot
      ? migrateTimelineSnapshot(snapshot)
      : createDefaultTimelineSnapshot();

    set({
      tracks: next.tracks,
      clips: next.clips,
      selectedClipIds: [],
      copiedClips: [],
      canUndo: false,
      canRedo: false,
    });
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

    if (effects.sam2MaskAssetIdsToDelete) {
      deleteSam2MaskAssets(effects.sam2MaskAssetIdsToDelete);
    }

    if (effects.compositeProxyAssetIdsToDelete) {
      deleteCompositeProxyAssets(effects.compositeProxyAssetIdsToDelete);
    }
  };

  return {
    commitModelMutation,
    flushPendingPersistence,
    redo,
    registerBeforeUnloadPersistence,
    replaceTimelineSnapshot,
    runPostCommitEffects,
    undo,
  };
}
