import { enablePatches } from "../../lib/immerLite";
import { create } from "zustand";
import type {
  Component,
  MaskCompositionAlgebra,
} from "../../types/Components";
import type { Asset } from "../../types/Asset";
import type {
  ClipMask,
  ClipTransform,
  MaskBooleanExpression,
  TimelineClip,
} from "../../types/TimelineTypes";
import type { TimelineSnapshot } from "../project/types/ProjectDocument";
import {
  countBrushMaskAssetConsumers,
  countSam2MaskAssetConsumers,
  makeMaskClipId,
  migrateLegacyMaskEdgeTransforms,
  parseMaskClipId,
} from "./model/maskClipModel";
import {
  addClipComponentToDraft,
  addClipMaskToDraft,
  addClipToDraft,
  addClipTransformToDraft,
  addTrackToDraft,
  copySelectedClips,
  duplicateClipMaskInDraft,
  duplicateTimelineClip,
  getTimelineClipsAtTime,
  insertTrackIntoDraft,
  pasteCopiedClipsAboveDraft,
  planTimelineRemoval,
  removeClipComponentFromDraft,
  removeClipIdsFromDraft,
  removeClipTransformFromDraft,
  replaceClipAssetInDraft,
  setClipMaskBooleanExpressionInDraft,
  setClipMaskCompositionAlgebraInDraft,
  setClipMaskCompositeTransformsInDraft,
  setClipTransformsInDraft,
  splitClipInDraft,
  toggleClipMuteInDraft,
  toggleTrackMuteInDraft,
  toggleTrackVisibilityInDraft,
  trimAndPadTracksInDraft,
  updateClipComponentInDraft,
  updateClipDurationInDraft,
  updateClipMaskInDraft,
  updateClipPositionInDraft,
  updateClipShapeInDraft,
  updateClipTransformInDraft,
  withTimelineClipDefaults,
  type TimelineClipShape,
  type TimelineMaskUpdate,
} from "./model/timelineCommands";
import {
  createDefaultTimelineSnapshot,
  createNewTrack,
  type TimelineModelState,
} from "./model/timelineTrackModel";
import {
  selectMaskClipsForParent,
  selectResolvedMaskBooleanExpressionForParent,
} from "./selectors/timelineSelectors";
import { createTimelineMutationPipeline } from "./store/timelineMutationPipeline";

enablePatches();

export {
  countBrushMaskAssetConsumers,
  countSam2MaskAssetConsumers,
  parseMaskClipId,
  selectMaskClipsForParent,
  selectResolvedMaskBooleanExpressionForParent,
};

interface TimelineState extends TimelineModelState {
  isFocused: boolean;
  selectedClipIds: string[];
  copiedClips: TimelineClip[];
  canUndo: boolean;
  canRedo: boolean;

  setFocused: (focused: boolean) => void;

  duplicateClip: (clip: TimelineClip) => TimelineClip;
  copySelectedClip: () => boolean;
  pasteCopiedClipAbove: () => boolean;
  splitClip: (clipId: string, splitTime: number) => void;

  addTrack: () => void;
  insertTrack: (index: number) => string;

  addClip: (clip: TimelineClip) => void;

  removeClip: (id: string) => void;
  removeClipsByAssetId: (assetId: string) => number;
  replaceClipAsset: (clipId: string, asset: Asset) => void;

  selectClip: (id: string | null, isMulti?: boolean) => void;

  updateClipPosition: (
    id: string,
    newStartTicks: number,
    newTrackId?: string,
  ) => void;

  updateClipShape: (
    id: string,
    shape: TimelineClipShape,
  ) => void;

  updateClipDuration: (id: string, newDurationTicks: number) => void;

  addClipTransform: (clipId: string, effect: ClipTransform) => void;

  updateClipTransform: (
    clipId: string,
    effectId: string,
    updates: Partial<Omit<ClipTransform, "id" | "type">>,
  ) => void;

  setClipTransforms: (clipId: string, transforms: ClipTransform[]) => void;
  setClipMaskCompositeTransforms: (
    clipId: string,
    transforms: ClipTransform[],
  ) => void;
  setClipMaskCompositionAlgebra: (
    clipId: string,
    algebra: MaskCompositionAlgebra,
  ) => void;
  setClipMaskBooleanExpression: (
    clipId: string,
    expression: MaskBooleanExpression | null,
  ) => void;

  removeClipTransform: (clipId: string, effectId: string) => void;

  addClipMask: (clipId: string, mask: ClipMask) => void;
  duplicateClipMask: (clipId: string, maskId: string) => string | null;

  updateClipMask: (
    clipId: string,
    maskId: string,
    updates: TimelineMaskUpdate,
  ) => void;

  removeClipMask: (clipId: string, maskId: string) => void;

  addClipComponent: (clipId: string, component: Component) => void;
  updateClipComponent: (
    clipId: string,
    componentId: string,
    updater: (component: Component) => Component,
  ) => void;
  removeClipComponent: (clipId: string, componentId: string) => void;

  toggleTrackVisibility: (trackId: string) => void;
  toggleTrackMute: (trackId: string) => void;
  toggleClipMute: (clipId: string) => void;
  trimAndPadTracks: () => void;

  undo: () => boolean;
  redo: () => boolean;

  replaceTimelineSnapshot: (snapshot: TimelineSnapshot | null) => void;
  flushPendingPersistence: () => Promise<void>;

  getClipsAtTime: (timeTicks: number) => TimelineClip[];
}

export const useTimelineStore = create<TimelineState>((set, get) => {
  const mutationPipeline = createTimelineMutationPipeline<TimelineState>({
    get,
    set,
    createDefaultTimelineSnapshot,
    migrateTimelineSnapshot: (snapshot) => ({
      tracks: structuredClone(snapshot.tracks),
      clips: migrateLegacyMaskEdgeTransforms(
        structuredClone(snapshot.clips),
        withTimelineClipDefaults,
      ),
    }),
  });

  mutationPipeline.registerBeforeUnloadPersistence();

  const initial = createDefaultTimelineSnapshot();

  return {
    tracks: initial.tracks,
    clips: initial.clips,
    isFocused: false,
    selectedClipIds: [],
    copiedClips: [],
    canUndo: false,
    canRedo: false,

    setFocused: (focused) => set({ isFocused: focused }),

    addTrack: () => {
      mutationPipeline.commitModelMutation((draft) => {
        addTrackToDraft(draft);
      });
    },

    insertTrack: (index) => {
      const newTrack = createNewTrack("New Track");
      mutationPipeline.commitModelMutation((draft) => {
        insertTrackIntoDraft(draft, index, newTrack);
      });
      return newTrack.id;
    },

    addClip: (clip) => {
      mutationPipeline.commitModelMutation((draft) => {
        addClipToDraft(draft, clip);
      });
    },

    duplicateClip: (clip) => duplicateTimelineClip(clip, get().clips),

    copySelectedClip: () => {
      const { selectedClipIds, clips, tracks } = get();
      const copiedClips = copySelectedClips(selectedClipIds, clips, tracks);
      if (copiedClips.length === 0) {
        return false;
      }

      set({ copiedClips });
      return true;
    },

    pasteCopiedClipAbove: () => {
      const { copiedClips } = get();
      let pastedClipIds: string[] = [];

      const didCommit = mutationPipeline.commitModelMutation((draft) => {
        pastedClipIds = pasteCopiedClipsAboveDraft(draft, copiedClips);
      });

      if (!didCommit || pastedClipIds.length === 0) {
        return false;
      }

      set({ selectedClipIds: pastedClipIds });
      return true;
    },

    splitClip: (clipId, splitTime) => {
      let rightClipId: string | null = null;

      const didCommit = mutationPipeline.commitModelMutation((draft) => {
        rightClipId = splitClipInDraft(draft, clipId, splitTime);
      });

      if (!didCommit || !rightClipId) return;
      const nextRightClipId = rightClipId;

      set((state) => ({
        selectedClipIds: state.selectedClipIds.map((id) =>
          id === clipId ? nextRightClipId : id,
        ),
      }));
    },

    removeClip: (id) => {
      const removalPlan = planTimelineRemoval(get().clips, [id]);
      const didCommit = mutationPipeline.commitModelMutation((draft) => {
        removeClipIdsFromDraft(draft, removalPlan.clipIdsToRemove);
      });

      if (didCommit) {
        mutationPipeline.runPostCommitEffects(removalPlan);
      }
    },

    removeClipsByAssetId: (assetId) => {
      const directlyReferencedClipIds = get()
        .clips.filter((clip) => clip.assetId === assetId)
        .map((clip) => clip.id);

      if (directlyReferencedClipIds.length === 0) {
        return 0;
      }

      const removalPlan = planTimelineRemoval(get().clips, directlyReferencedClipIds);
      const didCommit = mutationPipeline.commitModelMutation((draft) => {
        removeClipIdsFromDraft(draft, removalPlan.clipIdsToRemove);
      });

      if (didCommit) {
        mutationPipeline.runPostCommitEffects(removalPlan);
      }

      return directlyReferencedClipIds.length;
    },

    replaceClipAsset: (clipId, asset) => {
      mutationPipeline.commitModelMutation((draft) => {
        replaceClipAssetInDraft(draft, clipId, asset);
      });
    },

    selectClip: (id, isMulti = false) => {
      set((state) => {
        if (id === null) {
          return { selectedClipIds: [] };
        }

        if (isMulti) {
          const isSelected = state.selectedClipIds.includes(id);
          const selectedClipIds = isSelected
            ? state.selectedClipIds.filter((clipId) => clipId !== id)
            : [...state.selectedClipIds, id];

          return { selectedClipIds };
        }

        if (
          state.selectedClipIds.length === 1 &&
          state.selectedClipIds[0] === id
        ) {
          return state;
        }

        return { selectedClipIds: [id] };
      });
    },

    updateClipPosition: (id, newStartTicks, newTrackId) => {
      mutationPipeline.commitModelMutation((draft) => {
        updateClipPositionInDraft(draft, id, newStartTicks, newTrackId);
      });
    },

    updateClipShape: (id, shape) => {
      mutationPipeline.commitModelMutation((draft) => {
        updateClipShapeInDraft(draft, id, shape);
      });
    },

    updateClipDuration: (id, newDurationTicks) => {
      mutationPipeline.commitModelMutation((draft) => {
        updateClipDurationInDraft(draft, id, newDurationTicks);
      });
    },

    addClipTransform: (clipId, effect) => {
      mutationPipeline.commitModelMutation((draft) => {
        addClipTransformToDraft(draft, clipId, effect);
      });
    },

    updateClipTransform: (clipId, effectId, updates) => {
      mutationPipeline.commitModelMutation((draft) => {
        updateClipTransformInDraft(draft, clipId, effectId, updates);
      });
    },

    setClipTransforms: (clipId, transforms) => {
      mutationPipeline.commitModelMutation((draft) => {
        setClipTransformsInDraft(draft, clipId, transforms);
      });
    },

    setClipMaskCompositeTransforms: (clipId, transforms) => {
      mutationPipeline.commitModelMutation((draft) => {
        setClipMaskCompositeTransformsInDraft(draft, clipId, transforms);
      });
    },

    setClipMaskCompositionAlgebra: (clipId, algebra) => {
      mutationPipeline.commitModelMutation((draft) => {
        setClipMaskCompositionAlgebraInDraft(draft, clipId, algebra);
      });
    },

    setClipMaskBooleanExpression: (clipId, expression) => {
      mutationPipeline.commitModelMutation((draft) => {
        setClipMaskBooleanExpressionInDraft(draft, clipId, expression);
      });
    },

    removeClipTransform: (clipId, effectId) => {
      mutationPipeline.commitModelMutation((draft) => {
        removeClipTransformFromDraft(draft, clipId, effectId);
      });
    },

    addClipMask: (clipId, mask) => {
      mutationPipeline.commitModelMutation((draft) => {
        addClipMaskToDraft(draft, clipId, mask);
      });
    },

    duplicateClipMask: (clipId, maskId) => {
      let duplicatedMaskId: string | null = null;

      const didCommit = mutationPipeline.commitModelMutation((draft) => {
        duplicatedMaskId = duplicateClipMaskInDraft(draft, clipId, maskId);
      });

      return didCommit ? duplicatedMaskId : null;
    },

    updateClipMask: (clipId, maskId, updates) => {
      mutationPipeline.commitModelMutation((draft) => {
        updateClipMaskInDraft(draft, clipId, maskId, updates);
      });
    },

    removeClipMask: (clipId, maskId) => {
      const maskClipId = makeMaskClipId(clipId, maskId);
      const removalPlan = planTimelineRemoval(get().clips, [maskClipId]);
      const didCommit = mutationPipeline.commitModelMutation((draft) => {
        removeClipIdsFromDraft(draft, removalPlan.clipIdsToRemove);
      });

      if (didCommit) {
        mutationPipeline.runPostCommitEffects(removalPlan);
      }
    },

    addClipComponent: (clipId, component) => {
      mutationPipeline.commitModelMutation((draft) => {
        addClipComponentToDraft(draft, clipId, component);
      });
    },

    updateClipComponent: (clipId, componentId, updater) => {
      mutationPipeline.commitModelMutation((draft) => {
        updateClipComponentInDraft(draft, clipId, componentId, updater);
      });
    },

    removeClipComponent: (clipId, componentId) => {
      mutationPipeline.commitModelMutation((draft) => {
        removeClipComponentFromDraft(draft, clipId, componentId);
      });
    },

    toggleTrackVisibility: (trackId) => {
      mutationPipeline.commitModelMutation((draft) => {
        toggleTrackVisibilityInDraft(draft, trackId);
      });
    },

    toggleTrackMute: (trackId) => {
      mutationPipeline.commitModelMutation((draft) => {
        toggleTrackMuteInDraft(draft, trackId);
      });
    },

    toggleClipMute: (clipId) => {
      mutationPipeline.commitModelMutation((draft) => {
        toggleClipMuteInDraft(draft, clipId);
      });
    },

    trimAndPadTracks: () => {
      mutationPipeline.commitModelMutation((draft) => {
        trimAndPadTracksInDraft(draft);
      });
    },

    undo: () => mutationPipeline.undo(),
    redo: () => mutationPipeline.redo(),
    replaceTimelineSnapshot: mutationPipeline.replaceTimelineSnapshot,
    flushPendingPersistence: mutationPipeline.flushPendingPersistence,

    getClipsAtTime: (timeTicks) => getTimelineClipsAtTime(get().clips, timeTicks),
  };
});

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__TIMELINE_STORE__ =
    useTimelineStore;
}
